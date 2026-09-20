import { log } from "../log.js";

/**
 * Per-turn tool-call tracking, fed by the `knox-tool-telemetry` OpenClaw plugin
 * over the `/internal/tool-call` loopback route.
 *
 * OpenClaw runs the tool loop internally and the OpenAI-compat stream the shim
 * reads carries only assistant *content* — never the tool calls (see
 * `iterOpenaiDeltas`). So the shim learns about a tool call only through the
 * plugin: it fires `before_tool_call` (a "start" event) and, best-effort,
 * `after_tool_call` (an "end" event). This hub turns those into rows in
 * `public.agent_tool_calls`, attributed to the live turn.
 *
 * Attribution
 * -----------
 * A call's `session_key` (`webchat:<conv>` / `a2a:<conv>` / `task:<taskId>`) is
 * the anchor. `begin()` records the turn's context (its conversation, the
 * reserved assistant message the calls belong to, its task) so a card can be
 * anchored under the right assistant bubble; but even a call on a session the
 * shim never `begin()`d (a heartbeat, a sub-agent) is still attributed to a
 * conversation or task DERIVED from the key, so nothing is silently dropped.
 *
 * Correlation (start ↔ end)
 * -------------------------
 * `recordStart` inserts the row and remembers its id in a small per-session list
 * of "open" calls. `recordEnd` matches by `tool_call_id` when the runtime
 * supplies one, else by oldest-open (tool calls in a turn are effectively
 * sequential, so the oldest open call is the one that just finished). If the
 * running OpenClaw never fires `after_tool_call`, rows simply stay
 * `status='called'` — a complete audit + billing signal on their own.
 *
 * Everything here fails open: a telemetry hiccup must never break a turn.
 */

/** The subset of the messaging DB the hub needs. Kept as an interface so tests
 *  can inject a fake without a live Supabase client. */
export interface ToolCallDB {
  insertToolCall(row: InsertToolCallRow): Promise<string | null>;
  updateToolCall(id: string, patch: UpdateToolCallRow): Promise<boolean>;
}

export interface InsertToolCallRow {
  orgId: string;
  agentUid: string;
  conversationId: string | null;
  messageId: string | null;
  taskId: string | null;
  seq: number;
  toolName: string;
  server: string | null;
  toolCallId: string | null;
  argsPreview: unknown;
}

export interface UpdateToolCallRow {
  status?: "ok" | "error";
  error?: string | null;
  durationMs?: number | null;
  completedAt?: string;
}

/** The context of a turn the shim opened, keyed by OpenClaw session key. */
export interface ToolCallTurnContext {
  conversationId: string | null;
  /** The reserved assistant row the turn streams into; anchors the cards. */
  assistantMessageId: string | null;
  taskId: string | null;
}

export interface ToolCallStartEvent {
  sessionKey: string | null;
  toolName: string;
  server?: string | null;
  toolCallId?: string | null;
  argsPreview?: unknown;
}

export interface ToolCallEndEvent {
  sessionKey: string | null;
  toolName?: string | null;
  toolCallId?: string | null;
  status: "ok" | "error";
  /** Bounded diagnostic on failure; already length-capped by the plugin. */
  error?: string | null;
  durationMs?: number | null;
}

/** Running per-turn tallies, returned by `end()` for logging / rollups. */
export interface ToolCallTurnTotals {
  count: number;
  errorCount: number;
}

/** One in-flight tool call awaiting its end event. */
interface OpenCall {
  rowId: string;
  toolCallId: string | null;
  toolName: string;
  startedAt: number;
}

interface SessionState {
  ctx: ToolCallTurnContext;
  /** Monotonic sequence within the turn — ordering hint alongside created_at. */
  seq: number;
  totals: ToolCallTurnTotals;
  /** Rows inserted but not yet closed by an end event, oldest first. */
  open: OpenCall[];
}

/** Cap on live sessions tracked. A leak backstop for turns whose `end()` never
 *  runs (a crashed handler); over the cap we evict the oldest, losing at most
 *  one turn's correlation state, never unbounded memory. Mirrors the
 *  UsageAccumulator's MAX_COST_SESSIONS. */
const MAX_SESSIONS = 1024;
/** Cap on open (un-ended) calls held per session, so a runtime that fires
 *  `before_tool_call` but never `after_tool_call` cannot grow this unbounded. */
const MAX_OPEN_PER_SESSION = 256;

/** Derive the conversation id from a `webchat:` / `a2a:` session key, or null. */
export function conversationIdFromSessionKey(sessionKey: string | null): string | null {
  if (!sessionKey) return null;
  for (const prefix of ["webchat:", "a2a:"]) {
    if (sessionKey.startsWith(prefix)) {
      const id = sessionKey.slice(prefix.length).trim();
      return id.length > 0 ? id : null;
    }
  }
  return null;
}

/** Derive the task id from a `task:` session key, or null. */
export function taskIdFromSessionKey(sessionKey: string | null): string | null {
  if (!sessionKey || !sessionKey.startsWith("task:")) return null;
  const id = sessionKey.slice("task:".length).trim();
  return id.length > 0 ? id : null;
}

export class ToolCallHub {
  #bySession = new Map<string, SessionState>();
  readonly #db: ToolCallDB;
  readonly #orgId: string;
  readonly #agentUid: string;
  readonly #enabled: boolean;

  constructor(deps: {
    db: ToolCallDB;
    orgId: string;
    agentUid: string;
    enabled: boolean;
  }) {
    this.#db = deps.db;
    this.#orgId = deps.orgId;
    this.#agentUid = deps.agentUid;
    this.#enabled = deps.enabled;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Register (or reset) the context for a turn. Idempotent per session key:
   *  a re-`begin` on a live session key resets the per-turn seq + tallies but
   *  leaves any still-open calls to be matched by their end events. */
  begin(sessionKey: string, ctx: ToolCallTurnContext): void {
    if (!this.#enabled) return;
    const existing = this.#bySession.get(sessionKey);
    this.#bySession.set(sessionKey, {
      ctx,
      seq: 0,
      totals: { count: 0, errorCount: 0 },
      open: existing?.open ?? [],
    });
    if (this.#bySession.size > MAX_SESSIONS) {
      const oldest = this.#bySession.keys().next().value;
      if (oldest !== undefined && oldest !== sessionKey) {
        this.#bySession.delete(oldest);
      }
    }
  }

  /**
   * End a turn: drop its context and return the per-turn tallies. Open calls the
   * runtime never closed are discarded here (their rows stay `status='called'`).
   * No-op-safe on a session that was never begun.
   */
  end(sessionKey: string): ToolCallTurnTotals {
    const state = this.#bySession.get(sessionKey);
    this.#bySession.delete(sessionKey);
    return state?.totals ?? { count: 0, errorCount: 0 };
  }

  /** Insert a row for one tool call. Called from the loopback route on a
   *  plugin "start" event. Never throws. */
  async recordStart(ev: ToolCallStartEvent): Promise<void> {
    if (!this.#enabled) return;
    const toolName = typeof ev.toolName === "string" ? ev.toolName.trim() : "";
    if (!toolName) return;
    const sessionKey = ev.sessionKey ?? null;

    // Prefer the registered turn context (it carries the assistant message id we
    // anchor cards on); fall back to deriving the conversation/task straight from
    // the session key so a call on a turn the shim never opened is still attributed.
    const state = sessionKey ? this.#bySession.get(sessionKey) : undefined;
    const conversationId =
      state?.ctx.conversationId ?? conversationIdFromSessionKey(sessionKey);
    const taskId = state?.ctx.taskId ?? taskIdFromSessionKey(sessionKey);
    const messageId = state?.ctx.assistantMessageId ?? null;
    const seq = state ? state.seq++ : 0;

    let rowId: string | null = null;
    try {
      rowId = await this.#db.insertToolCall({
        orgId: this.#orgId,
        agentUid: this.#agentUid,
        conversationId,
        messageId,
        taskId,
        seq,
        toolName,
        server: ev.server ?? null,
        toolCallId: ev.toolCallId ?? null,
        argsPreview: ev.argsPreview ?? null,
      });
    } catch (err) {
      log.warn("tool-call insert threw (non-fatal)", { err: String(err) });
      return;
    }
    if (!rowId) return;

    if (state) {
      state.totals.count += 1;
      state.open.push({
        rowId,
        toolCallId: ev.toolCallId ?? null,
        toolName,
        startedAt: Date.now(),
      });
      // Bound the open list — a runtime that never fires end events must not grow
      // it forever. Drop the oldest (it will simply never be enriched).
      if (state.open.length > MAX_OPEN_PER_SESSION) state.open.shift();
    }
  }

  /** Enrich a row with its outcome. Called on a plugin "end" event. Best-effort:
   *  a call the hub can't match (no context, or already evicted) is dropped. */
  async recordEnd(ev: ToolCallEndEvent): Promise<void> {
    if (!this.#enabled) return;
    const sessionKey = ev.sessionKey ?? null;
    const state = sessionKey ? this.#bySession.get(sessionKey) : undefined;
    if (!state || state.open.length === 0) return;

    const open = this.#takeOpen(state, ev.toolCallId ?? null);
    if (!open) return;

    if (ev.status === "error") state.totals.errorCount += 1;
    const durationMs =
      typeof ev.durationMs === "number" && ev.durationMs >= 0
        ? Math.floor(ev.durationMs)
        : Date.now() - open.startedAt;
    try {
      await this.#db.updateToolCall(open.rowId, {
        status: ev.status,
        error: ev.status === "error" ? (ev.error ?? null) : null,
        durationMs,
        completedAt: new Date().toISOString(),
      });
    } catch (err) {
      log.warn("tool-call update threw (non-fatal)", { err: String(err) });
    }
  }

  /** Match by tool_call_id when both sides supplied one, else oldest-open. */
  #takeOpen(state: SessionState, toolCallId: string | null): OpenCall | null {
    if (toolCallId) {
      const idx = state.open.findIndex((o) => o.toolCallId === toolCallId);
      if (idx !== -1) return state.open.splice(idx, 1)[0] ?? null;
    }
    return state.open.shift() ?? null;
  }

  /** Live session count — for the health route and leak diagnosis. */
  size(): number {
    return this.#bySession.size;
  }
}
