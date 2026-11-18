import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { LLM_COMPLETE_PATH } from "../shim/conversation-title.js";

/**
 * Phone calls → the console.
 *
 * The voice-call plugin appends a full snapshot of a call to
 * `<state>/voice-calls/calls.jsonl` on every change (state, transcript). The
 * mirror tails that log and, for every call that was answered:
 *
 *   1. opens a console conversation for it (origin "phone") the moment it is
 *      answered — filed under the org member whose profile phone matches the
 *      other party, else unowned — so work started DURING the call (a
 *      background `start_task`) has a thread to post its card and result into;
 *   2. once the call ends, writes the transcript into that conversation, asks
 *      the agent's own model for a short summary (the knox-llm-complete route),
 *      posts it, and saves it as an episodic memory (`remember_memory`, the RPC
 *      behind the platform's `remember` tool) so the agent recalls the call in
 *      chat, on later calls and in tasks.
 *
 * It also answers, for the report-outcome plugin, "which conversation is this
 * voice session's call?" (see {@link VoiceConversationIndex}), which is how a
 * platform tool called mid-call gets a conversation id stamped onto it.
 *
 * Fail-soft throughout: a phone record that can't be written is logged and
 * skipped; nothing here can disturb a live call or the agent's other work.
 */

const POLL_MS = 2_000;
const SUMMARY_TIMEOUT_MS = 90_000;
const SUMMARY_MAX_TOKENS = 1_200;
/** Keep a finished call's session → conversation link this long, for a consult
 *  that is still running when the caller hangs up. */
const ENDED_LINK_TTL_MS = 15 * 60_000;

const TERMINAL_STATES = new Set([
  "completed",
  "hangup-user",
  "hangup-bot",
  "timeout",
  "error",
  "failed",
  "no-answer",
  "busy",
  "voicemail",
]);

export interface TranscriptEntry {
  timestamp: number;
  speaker: "bot" | "user";
  text: string;
  isFinal?: boolean;
}

/** The fields of the plugin's CallRecord the mirror reads. */
export interface CallRecord {
  callId: string;
  direction: "inbound" | "outbound";
  state: string;
  from: string;
  to: string;
  sessionKey?: string;
  startedAt: number;
  answeredAt?: number;
  endedAt?: number;
  endReason?: string;
  transcript?: TranscriptEntry[];
  metadata?: Record<string, unknown>;
}

export function isTerminal(call: CallRecord): boolean {
  return TERMINAL_STATES.has(call.state) || typeof call.endedAt === "number";
}

/** The other party's number. */
export function counterpart(call: CallRecord): string {
  return call.direction === "outbound" ? call.to : call.from;
}

export function digitsOf(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * The session key the plugin's realtime consult runs under for this call —
 * mirrors voice-call 2026.5.20 `resolveVoiceCallConsultSessionKey`: the call's
 * own `sessionKey`, else `voice:call:<callId>` (per-call scope) or
 * `voice:<digits>` (per-phone, the default).
 */
export function consultSessionKey(call: CallRecord, scope: "per-phone" | "per-call"): string {
  if (call.sessionKey) return call.sessionKey;
  if (scope === "per-call") return `voice:call:${call.callId}`;
  const digits = digitsOf(counterpart(call));
  return digits ? `voice:${digits}` : `voice:${call.callId}`;
}

/** The `voice:…` tail of a session key, however openclaw prefixed it. */
export function voiceSessionTail(sessionKey: string | null | undefined): string | null {
  if (!sessionKey) return null;
  const m = /(?:^|:)(voice:.+)$/.exec(sessionKey);
  return m ? m[1]! : null;
}

/** "+19016512542" → "+1 901-651-2542"; anything else unchanged. */
export function displayE164(phone: string): string {
  const d = digitsOf(phone);
  if (d.length === 11 && d.startsWith("1")) return `+1 ${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
  return phone;
}

/** "+19016512542" → "(901) 651-2542"; anything else unchanged. */
export function prettyPhone(phone: string): string {
  const d = digitsOf(phone);
  if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return phone;
}

/** Final transcript lines merged into speaker turns, oldest first. */
export function transcriptTurns(
  transcript: readonly TranscriptEntry[] | undefined,
): Array<{ speaker: "bot" | "user"; text: string }> {
  const turns: Array<{ speaker: "bot" | "user"; text: string }> = [];
  for (const e of transcript ?? []) {
    if (e.isFinal === false) continue;
    const text = dropRestatedPrefix(e.text.trim());
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.speaker === e.speaker) last.text = `${last.text} ${text}`;
    else turns.push({ speaker: e.speaker, text });
  }
  return turns;
}

const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The realtime plugin builds a caller's final transcript by appending the
 * provider's final text to the live partial it had so far, so a line can read
 * "Can you delegate a task to see how many Can you delegate a task to see how
 * many orders we confirmed today". Drop such a restated prefix: at a word
 * boundary, if the rest (letters/digits only) starts with everything before
 * it, keep only the rest. Repeats until stable; leaves ordinary text alone.
 */
export function dropRestatedPrefix(text: string): string {
  let out = text;
  for (let guard = 0; guard < 5; guard++) {
    let cut = -1;
    for (let i = out.indexOf(" "); i > 0; i = out.indexOf(" ", i + 1)) {
      const head = normalized(out.slice(0, i));
      if (head.length < 12) continue;
      if (normalized(out.slice(i)).startsWith(head)) cut = i;
    }
    if (cut < 0) break;
    out = out.slice(cut).trim();
  }
  return out;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

const SUMMARY_SYSTEM_PROMPT =
  "You write the record of a phone call an AI agent just had. Reply in plain text, no markdown headings. " +
  "First line: one or two sentences on what the call was about and how it ended. " +
  "Then, only if there are any, a line 'Follow-ups:' and short '- ' bullets for promises the agent made, " +
  "tasks it started, or things the caller asked it to do or remember. Do not invent anything not in the transcript.";

/** The knox-llm-complete request that asks for a call summary. */
export function buildSummaryRequest(
  turns: ReadonlyArray<{ speaker: "bot" | "user"; text: string }>,
  meta: { direction: string; party: string; duration: string },
): Record<string, unknown> {
  const lines = turns.map((t) => `${t.speaker === "bot" ? "Agent" : "Caller"}: ${t.text}`).join("\n");
  return {
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `${meta.direction} call with ${meta.party}, ${meta.duration}.\n<transcript>\n${lines}\n</transcript>`,
      },
    ],
    max_tokens: SUMMARY_MAX_TOKENS,
    timeout_ms: SUMMARY_TIMEOUT_MS,
    purpose: "knox-phone-call-summary",
  };
}

/** Strip reasoning a provider inlined; null when nothing usable is left. */
export function cleanSummary(raw: string): string | null {
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<think>[\s\S]*$/i, " ")
    .trim();
  return text.length > 0 ? text.slice(0, 4000) : null;
}

/** Live voice session → conversation links, read by the report-outcome plugin
 *  through `GET /internal/voice-conversation`. */
/** Who is on the line, as the voice-context plugin tells the agent. */
export interface CallerIdentity {
  name: string | null;
  /** Display form, e.g. "+1 901-651-2542". */
  phone: string;
  member: boolean;
}

export class VoiceConversationIndex {
  private readonly links = new Map<
    string,
    { conversationId: string; caller: CallerIdentity | null; expiresAt: number | null }
  >();
  /** Known callers by digits — answers "who is this?" before the mirror has
   *  linked the call (its log poll runs every couple of seconds). */
  private known = new Map<string, CallerIdentity>();

  setKnownCallers(callers: ReadonlyArray<{ phone: string; name: string; userId?: string }>): void {
    this.known = new Map(
      callers.map((c) => [
        digitsOf(c.phone),
        { name: c.name, phone: displayE164(c.phone), member: Boolean(c.userId) },
      ]),
    );
  }

  set(sessionKey: string, conversationId: string, caller: CallerIdentity | null = null): void {
    this.links.set(sessionKey, { conversationId, caller, expiresAt: null });
  }

  /** Conversation + caller for a voice session (the shim route's answer). */
  lookup(
    sessionKey: string | null | undefined,
    now = Date.now(),
  ): { conversation_id: string | null; caller: CallerIdentity | null } {
    const tail = voiceSessionTail(sessionKey);
    if (!tail) return { conversation_id: null, caller: null };
    const conversationId = this.get(tail, now);
    const link = conversationId ? this.links.get(tail) : undefined;
    let caller = link?.caller ?? null;
    if (!caller) {
      const m = /^voice:(\d{7,15})$/.exec(tail);
      if (m) caller = this.known.get(m[1]!) ?? { name: null, phone: displayE164(`+${m[1]}`), member: false };
    }
    return { conversation_id: conversationId, caller };
  }

  /** The call ended: keep the link a little longer for a consult still running. */
  release(sessionKey: string, now = Date.now()): void {
    const link = this.links.get(sessionKey);
    if (link) link.expiresAt = now + ENDED_LINK_TTL_MS;
  }

  get(sessionKey: string | null | undefined, now = Date.now()): string | null {
    const tail = voiceSessionTail(sessionKey);
    if (!tail) return null;
    const link = this.links.get(tail);
    if (!link) return null;
    if (link.expiresAt !== null && link.expiresAt < now) {
      this.links.delete(tail);
      return null;
    }
    return link.conversationId;
  }
}

/** Process-wide index (the shim route and the mirror share it). */
export const voiceConversations = new VoiceConversationIndex();

/** What the mirror needs from the outside world — injectable for tests. */
export interface CallMirrorStore {
  /** The org member whose profile phone matches, or null. */
  findMemberByPhone(digits: string): Promise<{ userId: string; name: string | null } | null>;
  createConversation(input: { userId: string | null; title: string }): Promise<string>;
  insertMessage(input: {
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    senderKind: "user" | "agent" | "system";
    senderId: string | null;
    systemGenerated?: boolean;
  }): Promise<void>;
  remember(input: { conversationId: string; body: string; tags: string[] }): Promise<void>;
}

export interface CallMirrorDeps {
  store: CallMirrorStore;
  agentUid: string;
  scope: "per-phone" | "per-call";
  /** The spec's known callers ("Accept calls from" members). Matched first;
   *  a profile-phone match is the fallback. */
  callers?: ReadonlyArray<{ phone: string; name: string; userId?: string }>;
  /** Ask the agent's model for a summary; null when unavailable. */
  summarize: (request: Record<string, unknown>) => Promise<string | null>;
  index?: VoiceConversationIndex;
  now?: () => number;
}

interface MirrorState {
  conversationId?: string;
  /** The matched org member, if any (the conversation's owner). */
  userId?: string | null;
  /** How the other party is named in titles and the summary. */
  who?: string;
  done?: boolean;
}

/**
 * Turns call snapshots into console records. Pure of I/O apart from its deps,
 * so tests drive it with `handle()` directly; {@link CallLogTail} feeds it.
 */
export class CallMirror {
  /** Per-call progress. Persisted by the tail so a restart neither duplicates
   *  nor drops a call. */
  readonly state = new Map<string, MirrorState>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly index: VoiceConversationIndex;

  constructor(private readonly deps: CallMirrorDeps) {
    this.index = deps.index ?? voiceConversations;
  }

  /** Feed one snapshot. Calls are processed one snapshot at a time each, in order. */
  handle(call: CallRecord): Promise<void> {
    const prev = this.pending.get(call.callId) ?? Promise.resolve();
    const next = prev.then(() => this.process(call)).catch((err) => {
      log.error("phone call mirror failed", { callId: call.callId, err: String(err) });
    });
    this.pending.set(call.callId, next);
    return next;
  }

  async idle(): Promise<void> {
    await Promise.all([...this.pending.values()]);
  }

  private async process(call: CallRecord): Promise<void> {
    const st = this.state.get(call.callId) ?? {};
    if (st.done) return;
    // Only calls someone actually picked up become records (not a ring-out,
    // a busy line, or an inbound call the allowlist refused).
    if (typeof call.answeredAt !== "number") {
      if (isTerminal(call)) this.state.set(call.callId, { ...st, done: true });
      return;
    }
    const sessionKey = consultSessionKey(call, this.deps.scope);

    if (!st.conversationId) {
      const party = counterpart(call);
      const known = (this.deps.callers ?? []).find((c) => digitsOf(c.phone) === digitsOf(party));
      const member = known
        ? known.userId
          ? { userId: known.userId, name: known.name }
          : null
        : await this.deps.store.findMemberByPhone(digitsOf(party)).catch(() => null);
      const who = known?.name || member?.name?.trim() || prettyPhone(party);
      const title =
        call.direction === "outbound" ? `Phone call to ${who}` : `Phone call from ${who}`;
      st.conversationId = await this.deps.store.createConversation({
        userId: member?.userId ?? null,
        title,
      });
      st.userId = member?.userId ?? null;
      st.who = who;
      this.state.set(call.callId, st);
      this.index.set(sessionKey, st.conversationId, {
        name: known?.name || member?.name?.trim() || null,
        phone: displayE164(party),
        member: Boolean(member),
      });
      log.info("phone call mirrored", {
        callId: call.callId,
        direction: call.direction,
        conversation_id: st.conversationId,
        matched_member: Boolean(member),
      });
    }

    if (!isTerminal(call)) return;
    await this.finish(call, st as MirrorState & { conversationId: string });
    this.index.release(sessionKey);
  }

  private async finish(
    call: CallRecord,
    st: MirrorState & { conversationId: string },
  ): Promise<void> {
    const { store, agentUid } = this.deps;
    const conversationId = st.conversationId;
    const turns = transcriptTurns(call.transcript);
    for (const t of turns) {
      await store.insertMessage({
        conversationId,
        role: t.speaker === "bot" ? "assistant" : "user",
        content: t.text,
        senderKind: t.speaker === "bot" ? "agent" : "user",
        senderId: t.speaker === "bot" ? agentUid : (st.userId ?? null),
      });
    }

    const duration = formatDuration((call.endedAt ?? this.now()) - (call.answeredAt ?? call.startedAt));
    const party = st.who ?? prettyPhone(counterpart(call));
    const callerSpoke = turns.some((t) => t.speaker === "user");
    let summary: string | null = null;
    if (callerSpoke) {
      summary = await this.deps
        .summarize(
          buildSummaryRequest(turns, {
            direction: call.direction === "outbound" ? "Outbound" : "Inbound",
            party,
            duration,
          }),
        )
        .catch(() => null);
    }
    const header = `Call ended · ${duration}${call.endReason ? ` · ${call.endReason}` : ""}`;
    await store.insertMessage({
      conversationId,
      role: "assistant",
      content: summary ? `${header}\n\n${summary}` : header,
      senderKind: "agent",
      senderId: agentUid,
      systemGenerated: !summary,
    });

    if (summary) {
      const date = new Date(call.answeredAt ?? call.startedAt).toISOString().slice(0, 10);
      await store
        .remember({
          conversationId,
          body: `Phone call ${call.direction === "outbound" ? "to" : "from"} ${party} on ${date} (${duration}): ${summary}`,
          tags: ["phone-call"],
        })
        .catch((err) => log.warn("phone call memory not saved", { err: String(err) }));
    }
    st.done = true;
    this.state.set(call.callId, st);
    log.info("phone call recorded", {
      callId: call.callId,
      conversation_id: conversationId,
      turns: turns.length,
      summarized: Boolean(summary),
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

/**
 * Tails `calls.jsonl` into a {@link CallMirror}. Remembers its byte offset and
 * each call's progress in `knox-call-mirror.json` beside the log (on the
 * volume), so a restart resumes where it stopped.
 */
export class CallLogTail {
  private offset = 0;
  private partial = "";
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly logPath: string;
  private readonly statePath: string;

  constructor(
    private readonly dir: string,
    private readonly mirror: CallMirror,
  ) {
    this.logPath = join(dir, "calls.jsonl");
    this.statePath = join(dir, "knox-call-mirror.json");
  }

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.statePath, "utf8")) as {
        offset?: number;
        calls?: Record<string, MirrorState>;
      };
      this.offset = typeof saved.offset === "number" ? saved.offset : 0;
      for (const [id, s] of Object.entries(saved.calls ?? {})) this.mirror.state.set(id, s);
    } catch {
      // First run: start at the end so years of old calls aren't replayed.
      this.offset = await stat(this.logPath).then((s) => s.size).catch(() => 0);
    }
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref?.();
    await this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const size = await stat(this.logPath).then((s) => s.size).catch(() => 0);
      if (size < this.offset) {
        this.offset = 0; // rotated / truncated
        this.partial = "";
      }
      if (size === this.offset) return;
      const fh = await open(this.logPath, "r");
      let chunk: string;
      try {
        const buf = Buffer.alloc(size - this.offset);
        await fh.read(buf, 0, buf.length, this.offset);
        chunk = buf.toString("utf8");
      } finally {
        await fh.close();
      }
      this.offset = size;
      const text = this.partial + chunk;
      const lines = text.split("\n");
      this.partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let call: CallRecord;
        try {
          call = JSON.parse(line) as CallRecord;
        } catch {
          continue;
        }
        if (!call?.callId) continue;
        void this.mirror.handle(call);
      }
      await this.mirror.idle();
      await this.save();
    } catch (err) {
      log.warn("phone call log tail failed", { err: String(err) });
    } finally {
      this.running = false;
    }
  }

  private async save(): Promise<void> {
    const calls: Record<string, MirrorState> = {};
    for (const [id, s] of this.mirror.state) {
      calls[id] = { ...s };
    }
    // Bound the file: finished calls older than the last 500 are dropped.
    const ids = Object.keys(calls);
    for (const id of ids.slice(0, Math.max(0, ids.length - 500))) {
      if (calls[id]?.done) delete calls[id];
    }
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, JSON.stringify({ offset: this.offset - Buffer.byteLength(this.partial), calls }), "utf8");
    await rename(tmp, this.statePath);
  }
}

/** The Supabase-backed store (service role, same as the shim's MessagingDB). */
export class SupabaseCallMirrorStore implements CallMirrorStore {
  private readonly client: SupabaseClient;

  constructor(
    private readonly env: AgentEnv,
    client?: SupabaseClient,
  ) {
    this.client =
      client ??
      createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
  }

  async findMemberByPhone(digits: string): Promise<{ userId: string; name: string | null } | null> {
    if (digits.length < 7) return null;
    const { data: members } = await this.client
      .from("org_members")
      .select("user_id")
      .eq("org_id", this.env.AGENT_ORG);
    const ids = (members ?? []).map((m: { user_id: string }) => m.user_id);
    if (ids.length === 0) return null;
    const { data: users } = await this.client
      .from("users")
      .select("id, phone, display_name")
      .in("id", ids)
      .not("phone", "is", null);
    const want = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
    for (const u of (users ?? []) as Array<{ id: string; phone: string | null; display_name: string | null }>) {
      let d = digitsOf(u.phone ?? "");
      if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
      if (d && d === want) return { userId: u.id, name: u.display_name };
    }
    return null;
  }

  async createConversation(input: { userId: string | null; title: string }): Promise<string> {
    const { data, error } = await this.client
      .from("conversations")
      .insert({
        org_id: this.env.AGENT_ORG,
        agent_uid: this.env.AGENT_UID,
        user_id: input.userId,
        title: input.title,
        origin: "phone",
      })
      .select("id")
      .single();
    if (error) throw new Error(`create phone conversation: ${error.message}`);
    return (data as { id: string }).id;
  }

  async insertMessage(input: Parameters<CallMirrorStore["insertMessage"]>[0]): Promise<void> {
    const row: Record<string, unknown> = {
      conversation_id: input.conversationId,
      role: input.role,
      content: input.content,
      status: "complete",
      system_generated: input.systemGenerated ?? false,
      sender_kind: input.senderKind,
    };
    if (input.senderId) row.sender_id = input.senderId;
    const { error } = await this.client.from("messages").insert(row);
    if (error) throw new Error(`insert phone message: ${error.message}`);
  }

  async remember(input: { conversationId: string; body: string; tags: string[] }): Promise<void> {
    const { error } = await this.client.rpc("remember_memory", {
      p_org_id: this.env.AGENT_ORG,
      p_agent_uid: this.env.AGENT_UID,
      p_body: input.body,
      p_title: null,
      p_kind: "episodic",
      p_tags: input.tags,
      p_salience: 40,
      p_pinned: false,
      p_conversation_id: input.conversationId,
      p_expires_at: null,
    });
    if (error) throw new Error(`remember_memory: ${error.message}`);
  }
}

/** Summaries come from the agent's own model via the knox-llm-complete route. */
export function llmCompleteSummarizer(env: AgentEnv, fetchImpl: typeof fetch = fetch) {
  return async (request: Record<string, unknown>): Promise<string | null> => {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${env.OPENCLAW_GATEWAY_PORT}${LLM_COMPLETE_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENCLAW_GATEWAY_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS + 10_000),
      });
      const body = (await res.json().catch(() => null)) as { text?: unknown } | null;
      if (!res.ok || typeof body?.text !== "string") {
        log.warn("phone call summary failed", { status: res.status });
        return null;
      }
      return cleanSummary(body.text);
    } catch (err) {
      log.warn("phone call summary failed", { err: String(err) });
      return null;
    }
  };
}

/** Where the plugin keeps its call log: `~/.openclaw/voice-calls`, with the
 *  gateway's HOME set to the state dir's parent (see gateway-process.ts). */
export function voiceCallsDir(env: AgentEnv): string {
  return join(env.OPENCLAW_STATE_DIR, "voice-calls");
}
