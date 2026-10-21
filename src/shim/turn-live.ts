import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import type { Mcq } from "./mcq.js";

/**
 * Live delivery of a chat turn, decoupled from the HTTP request that started it.
 *
 * A turn used to exist only on its SSE response: the reply text lived in a local
 * buffer until the turn finished, so a client that closed the tab, left the
 * session, or had its stream cut by an edge timeout saw nothing until the very
 * end — and nothing at all if the container restarted. The turn now has three
 * outputs, none of which depends on who is still listening:
 *
 *   1. the assistant row, saved as the reply streams (`StreamingRowWriter`) —
 *      the durable source of truth any client can load or poll;
 *   2. token deltas on the private Realtime topic `conversation:<id>`
 *      (`TurnBroadcaster`), so every open client sees the reply smoothly; and
 *   3. the SSE response, when the caller asked for one — now just a fast path.
 *
 * A client closing its socket never cancels the turn. Only an explicit
 * `/interrupt` does (see cancel-registry.ts).
 *
 * Every delta carries `offset`, the length of the visible reply before it, in
 * the same coordinates as the row's saved `content`. A client that loaded the
 * row mid-turn appends only the part of a delta past what it already has, and
 * ignores a delta that starts beyond it (it missed one) until the next row save
 * catches it up.
 */

/** How often the streaming reply is saved to its row. Each save is one UPDATE
 *  (and one realtime row event), so this is the write cadence per live turn. */
export const ROW_SAVE_INTERVAL_MS = 1_000;

/** How long token deltas are coalesced before one broadcast message. */
export const BROADCAST_INTERVAL_MS = 100;

/** Realtime topic every client following a conversation joins. Private: the
 *  console's RLS on `realtime.messages` admits only members of the
 *  conversation's org (console migration 0154). */
export function conversationTopic(conversationId: string): string {
  return `conversation:${conversationId}`;
}

/** Wire shape of one broadcast `turn` event. */
export type TurnEvent =
  | { type: "start"; message_id: string; user_message_id: string }
  | { type: "token"; message_id: string; offset: number; delta: string }
  | { type: "question"; message_id: string; question: Mcq }
  | {
      type: "done";
      message_id: string;
      status: "complete" | "interrupted" | "error";
    };

// ── Per-conversation turn serialization ─────────────────────────────────────

/**
 * One turn at a time per conversation. With the socket no longer holding the
 * turn, a person can send again while the previous reply is still running (or
 * an A2A caller can re-send after its client timed out). The second turn waits
 * here before it reads history, so it is built on the first turn's finished
 * reply instead of an empty in-progress row, and two openclaw runs never share
 * one session at once.
 *
 * Also the registry of in-flight turns, so shutdown can wait for them to write
 * their final state.
 */
export class TurnLocks {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly inflight = new Set<Promise<void>>();

  /** Resolves once every earlier turn on `key` has released. The returned
   *  release function is idempotent. */
  async acquire(key: string): Promise<() => void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    this.inflight.add(mine);
    await prev;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inflight.delete(mine);
      if (this.tails.get(key) === tail) this.tails.delete(key);
      release();
    };
  }

  /** Wait (bounded) for every turn that holds or awaits a lock to release. */
  async drain(timeoutMs: number): Promise<boolean> {
    if (this.inflight.size === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((r) => {
      timer = setTimeout(() => r(false), timeoutMs);
    });
    const all = Promise.all([...this.inflight]).then(() => true as const);
    const ok = await Promise.race([all, timeout]);
    clearTimeout(timer);
    return ok;
  }
}

// ── Row saves ───────────────────────────────────────────────────────────────

export interface StreamingRowStore {
  /** Save `content` onto a row that is still `streaming`; a no-op once the row
   *  has been finalized, so a late save can never clobber the final reply. */
  saveStreamingContent(messageId: string, content: string): Promise<boolean>;
}

/**
 * Saves the visible reply to its row at most every `intervalMs`, one save in
 * flight at a time. `settle()` stops the timer and waits for the in-flight save,
 * so the caller's final UPDATE always lands last.
 */
export class StreamingRowWriter {
  private latest = "";
  private saved = "";
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private settled = false;

  constructor(
    private readonly store: StreamingRowStore,
    private readonly messageId: string,
    private readonly intervalMs = ROW_SAVE_INTERVAL_MS,
  ) {}

  update(visible: string): void {
    if (this.settled) return;
    this.latest = visible;
    if (this.timer || this.inflight) return;
    this.timer = setTimeout(() => this.flush(), this.intervalMs);
    this.timer.unref?.();
  }

  private flush(): void {
    this.timer = null;
    if (this.settled || this.latest === this.saved) return;
    const content = this.latest;
    this.inflight = this.store
      .saveStreamingContent(this.messageId, content)
      .then(
        () => {
          this.saved = content;
        },
        (err: unknown) => {
          log.warn("streaming row save failed", { err: String(err) });
        },
      )
      .finally(() => {
        this.inflight = null;
        // Text that arrived during the save goes out on the next tick.
        if (!this.settled && this.latest !== this.saved) this.update(this.latest);
      });
  }

  async settle(): Promise<void> {
    this.settled = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inflight;
  }
}

// ── Broadcast ───────────────────────────────────────────────────────────────

export interface TurnPublisher {
  /** Publish one or more events on a topic. Rejects on delivery failure. */
  publish(topic: string, events: TurnEvent[]): Promise<void>;
}

/**
 * Publishes over Supabase Realtime's broadcast REST endpoint with the service
 * role key (which is not subject to the topic's RLS). Same request the
 * supabase-js `channel.httpSend()` makes, minus the client.
 */
export class RealtimeRestPublisher implements TurnPublisher {
  private readonly url: string;
  private readonly key: string;

  constructor(env: Pick<AgentEnv, "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY">) {
    this.url = `${env.SUPABASE_URL.replace(/\/+$/, "")}/realtime/v1/api/broadcast`;
    this.key = env.SUPABASE_SERVICE_ROLE_KEY;
  }

  async publish(topic: string, events: TurnEvent[]): Promise<void> {
    if (events.length === 0) return;
    const resp = await fetch(this.url, {
      method: "POST",
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: events.map((payload) => ({
          topic,
          event: "turn",
          payload,
          private: true,
        })),
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (resp.status !== 202 && !resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`broadcast ${resp.status}: ${text.slice(0, 200)}`);
    }
  }
}

/** Publisher that drops everything (AGENT_TURN_BROADCAST=false, tests). */
export const noopPublisher: TurnPublisher = {
  async publish() {},
};

/**
 * One turn's broadcast stream. Token deltas are coalesced for
 * `BROADCAST_INTERVAL_MS`; control events (start / question / done) flush
 * pending tokens and go out immediately, in order. Delivery is best effort — a
 * failed publish is logged once per turn and dropped; the row saves are what a
 * client can always fall back to.
 */
export class TurnBroadcaster {
  private readonly topic: string;
  private pendingDelta = "";
  private pendingOffset = 0;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private warned = false;
  private closed = false;

  constructor(
    private readonly publisher: TurnPublisher,
    conversationId: string,
    private readonly messageId: string,
    private readonly intervalMs = BROADCAST_INTERVAL_MS,
  ) {
    this.topic = conversationTopic(conversationId);
  }

  start(userMessageId: string): void {
    this.send([
      { type: "start", message_id: this.messageId, user_message_id: userMessageId },
    ]);
  }

  /** `offset` is the visible reply's length before `delta`. */
  token(delta: string, offset: number): void {
    if (this.closed || !delta) return;
    if (!this.pendingDelta) this.pendingOffset = offset;
    this.pendingDelta += delta;
    if (this.timer) return;
    this.timer = setTimeout(() => this.send([]), this.intervalMs);
    this.timer.unref?.();
  }

  question(question: Mcq): void {
    this.send([{ type: "question", message_id: this.messageId, question }]);
  }

  /** Final event. Flushes everything and waits for delivery (bounded by the
   *  publisher's own timeout). */
  async done(status: "complete" | "interrupted" | "error"): Promise<void> {
    this.send([{ type: "done", message_id: this.messageId, status }]);
    this.closed = true;
    await this.chain;
  }

  private send(control: TurnEvent[]): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const events: TurnEvent[] = [];
    if (this.pendingDelta) {
      events.push({
        type: "token",
        message_id: this.messageId,
        offset: this.pendingOffset,
        delta: this.pendingDelta,
      });
      this.pendingDelta = "";
    }
    events.push(...control);
    if (events.length === 0) return;
    this.chain = this.chain.then(() =>
      this.publisher.publish(this.topic, events).catch((err: unknown) => {
        if (this.warned) return;
        this.warned = true;
        log.warn("turn broadcast failed (row saves still deliver the reply)", {
          topic: this.topic,
          err: String(err),
        });
      }),
    );
  }
}
