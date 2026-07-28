import type { IncomingHttpHeaders } from "node:http";

import type { DelegatedCredentials } from "../bundle/client.js";

/**
 * Platform-brokered delegated credentials — the consumer side.
 *
 * On a DELEGATED (agent-to-agent) turn, the calling agent may share some of its
 * own credentials with THIS agent for the duration of that one turn. The runtime
 * pulls them from the platform (see `BundleClient.fetchDelegatedCredentials`) and
 * exposes them ONLY to the skill/tool execution environment for that turn —
 * never to the model prompt, the transcript, or the logs.
 *
 * This module owns two pieces:
 *   1. `detectDelegatedTurn` — recognize a delegated turn from the platform's
 *      request headers (cross-checked against the verified caller principal).
 *   2. `DelegatedCredentialStore` — hold the per-turn creds in memory, keyed by
 *      the openclaw session key, so concurrent turns never see each other's
 *      secrets and nothing persists past the turn.
 *
 * The actual injection into skill subprocess env happens in the openclaw
 * `before_tool_call` plugin, which reads these creds back over a loopback route.
 */

// Headers the platform stamps on a proxied turn (see BYOA.md + the delegation
// contract). Node lower-cases incoming header names, so these are lower-case.
export const CALLER_KIND_HEADER = "x-knox-caller-kind";
export const DELEGATION_CONNECTION_HEADER = "x-knox-delegation-connection-id";
export const CONVERSATION_ID_HEADER = "x-knox-conversation-id";

export interface DelegatedTurn {
  /** True only when this is a platform-brokered agent-to-agent turn. */
  delegated: boolean;
  /** Conversation being handled — the request path is authoritative; the
   *  `X-Knox-Conversation-Id` header is a fallback. */
  conversationId: string;
  /** The delegation connection id, when the platform provided one (audit/debug
   *  only — the platform, not this value, authorizes the credential release). */
  connectionId: string | null;
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Decide whether the inbound turn is a platform-brokered A2A delegation.
 *
 * Requires BOTH signals so a spoofed header alone can't trigger a credential
 * fetch:
 *   - the verified caller principal is an agent (from the A2A JWT), AND
 *   - the platform-set `X-Knox-Caller-Kind` header is `agent`.
 *
 * This does not change or weaken the existing bearer verification — the
 * principal is already the result of full JWT signature + claim checks; we only
 * gate the EXTRA credential fetch behind it. Conversation id comes from the
 * request path (authoritative) and falls back to the header.
 */
export function detectDelegatedTurn(
  headers: IncomingHttpHeaders,
  principalKind: "user" | "agent",
  pathConversationId: string,
): DelegatedTurn {
  const callerKind = firstHeader(headers[CALLER_KIND_HEADER])?.trim().toLowerCase();
  const conversationId =
    pathConversationId.trim() ||
    firstHeader(headers[CONVERSATION_ID_HEADER])?.trim() ||
    "";
  const delegated =
    principalKind === "agent" &&
    callerKind === "agent" &&
    conversationId.length > 0;
  return {
    delegated,
    conversationId,
    connectionId: firstHeader(headers[DELEGATION_CONNECTION_HEADER])?.trim() || null,
  };
}

/** Redacted key list for logs — names only, never values. */
export function credentialKeyNames(creds: DelegatedCredentials): string[] {
  return Object.keys(creds).sort();
}

/**
 * Ephemeral system note injected into the model's messages on a DELEGATED turn
 * (see `routes-messages`). It carries NO credential values — it is pure
 * behavioral steering — so it does not violate the "never put secrets in the
 * prompt/transcript" rule; it is added only to the outgoing message array and is
 * never persisted to the conversation history.
 *
 * Why it exists: the brokered credentials are injected into the skill's `exec`
 * environment and are deliberately invisible to the model. Weaker models
 * (observed with gpt-4o) treat that invisibility as "I have no access": they
 * call `get_my_bundle` / `get_delegated_credentials` hunting for the key, find
 * nothing, and give up — or spawn a sub-agent instead of just running the skill.
 * Stronger models run the skill and let it authenticate. This note makes the
 * intended behavior explicit for the models that don't infer it. It reinforces,
 * and is reinforced by, the per-skill A2A instructions in the skills repo.
 */
export const DELEGATED_TURN_SYSTEM_NOTE = [
  "SYSTEM (delegated agent-to-agent turn):",
  "This is a platform-brokered delegated turn. Any credentials your skills need",
  "for it have ALREADY been provisioned into the skill execution environment by",
  "the runtime. You will NOT see them in your context — that is intentional and",
  "correct, not a sign that access is missing.",
  "",
  "To do the requested work, RUN THE RELEVANT SKILL directly with the `exec`",
  "tool (e.g. `python3 scripts/<skill>.py <action> ...`). Do NOT, before running",
  "it: (1) call get_my_bundle, get_delegated_credentials, or any tool to look for",
  "or verify credentials — they are intentionally invisible to you; (2) spawn a",
  "sub-agent (sessions_spawn) to do a skill's job — you are the agent that runs",
  "the skill; (3) tell the caller you lack access or credentials before you have",
  "actually run the skill's script and read its error output. If a skill truly",
  "cannot authenticate, it emits a clear error — surface THAT, do not preempt it.",
].join("\n");

interface StoreEntry {
  creds: DelegatedCredentials;
  expiresAt: number;
  /** Identifies the turn that staged this entry — see `clear`. */
  lease: number;
}

/**
 * Opaque handle returned by `set`, to be handed back to `clear` when the turn
 * that staged the credentials ends.
 */
export type CredentialLease = number;

/**
 * In-memory, per-turn store of delegated credentials keyed by the openclaw
 * session key (e.g. `a2a:<conversationId>`). The shim writes an entry just
 * before proxying a delegated turn to the gateway and deletes it when the turn
 * ends; the loopback credential route reads it while the turn's skills run.
 *
 * Keyed isolation is the whole point. Two agents delegating to this one at the
 * same time land under two different session keys, so they never race on a
 * shared global — the exact failure mode a single mutable env var would have
 * (last-writer-wins across concurrent turns, and a value that outlives its
 * turn). The short TTL is a backstop so a crashed turn can't leave secrets
 * resident indefinitely; the primary lifecycle is set-before / clear-after.
 *
 * Nothing here is written to disk or to any long-lived process env.
 */
export class DelegatedCredentialStore {
  private readonly entries = new Map<string, StoreEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private nextLease = 1;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000; // 10 min backstop
    this.now = opts.now ?? ((): number => Date.now());
  }

  /**
   * Store the creds for a session's current turn and return the LEASE that
   * identifies this staging. Empty maps and empty session keys are ignored
   * (nothing to expose) and yield lease 0, which `clear` treats as "not mine".
   *
   * The lease exists because the key is the SESSION, not the turn, and two turns
   * on one session can overlap — see `clear`.
   */
  set(sessionKey: string, creds: DelegatedCredentials): CredentialLease {
    if (!sessionKey || Object.keys(creds).length === 0) return 0;
    const lease = this.nextLease++;
    this.entries.set(sessionKey, {
      creds,
      expiresAt: this.now() + this.ttlMs,
      lease,
    });
    return lease;
  }

  /** Read the creds for a session, or `{}` when absent or expired. */
  get(sessionKey: string): DelegatedCredentials {
    const hit = this.entries.get(sessionKey);
    if (!hit) return {};
    if (hit.expiresAt <= this.now()) {
      this.entries.delete(sessionKey);
      return {};
    }
    return hit.creds;
  }

  /**
   * Creds of the SINGLE currently-live delegated turn, or `{}` when zero — or
   * more than one — are staged.
   *
   * The exec-shim (see `docker/knox-python3-shim.py`) needs this because
   * openclaw does not expose the session key to a skill's `exec` subprocess, so
   * a shim running inside that subprocess can't ask for its own session by name.
   * These agents serialize their turns (openclaw's main lane), so in practice
   * there is exactly one live delegated turn when a skill runs, and returning it
   * is correct. The ">1 → {}" rule is a deliberate FAIL-CLOSED guard: if two
   * delegated turns ever overlap we return nothing (the skill surfaces its own
   * auth error) rather than risk handing one caller's credential to another.
   */
  currentSingle(): DelegatedCredentials {
    const live: DelegatedCredentials[] = [];
    const liveKeys: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= this.now()) this.entries.delete(key);
      else {
        live.push(entry.creds);
        liveKeys.push(key);
      }
    }
    if (live.length > 1) {
      // Fail-closed, but say so. Before long-running tasks this was a
      // vanishingly rare race between two overlapping delegated turns; a
      // `task:` session can now be live for an hour, so an overlap is a real
      // possibility and its symptom (a skill suddenly reporting no credentials)
      // is otherwise completely mysterious. The task runner serializes
      // credential-carrying TASKS for exactly this reason — what remains is a
      // delegated message turn landing while a delegated task runs.
      // Names only, never values.
      console.error(
        `[delegated-credentials] ${live.length} delegated turns live at once ` +
          `(${liveKeys.join(", ")}) — returning NOTHING rather than risk handing ` +
          `one caller's credential to another. The skill will report an auth error.`,
      );
    }
    return live.length === 1 ? live[0]! : {};
  }

  /**
   * Drop a session's creds — called when the turn that staged them ends.
   * Idempotent.
   *
   * `lease` MUST be the value `set` returned for that turn. Passing it makes the
   * clear a no-op when some LATER turn has since re-staged under the same key,
   * which is not hypothetical:
   *
   *   11:32:52  turn 2 stages creds for a2a:41fe1a7c… (queued behind turn 1)
   *   11:32:57  turn 1 ends → clear(a2a:41fe1a7c…) → wipes TURN 2's entry
   *   11:32:58  turn 2 starts running
   *   11:33:07  exec hook: creds=0 keys=[]
   *
   * The agent then told its caller the vendor's API credentials "aren't
   * configured" — a wrong answer produced by a lifecycle bug, not by anything
   * about the vendor. The trigger was the caller re-sending a message after the
   * MCP client's 60s timeout while the first turn was still streaming, so any
   * two overlapping turns on one conversation reproduce it.
   *
   * Omitting `lease` keeps the old unconditional behaviour. The task runner
   * relies on that and MUST keep relying on it: its heartbeat re-stages the
   * credentials every ~30s (so an hour-long task cannot age past the store's
   * 10-minute TTL), which mints a fresh lease each beat. A task holding its
   * ORIGINAL lease would therefore fail to match on cleanup and leave the
   * secrets resident until the TTL — so do not "tighten" that call site by
   * threading a lease through it. It is safe unconditionally because a
   * `task:<taskId>` key is unique to one task and nothing else ever writes it.
   */
  clear(sessionKey: string, lease?: CredentialLease): void {
    if (lease === undefined) {
      this.entries.delete(sessionKey);
      return;
    }
    const hit = this.entries.get(sessionKey);
    if (!hit || hit.lease !== lease) return;
    this.entries.delete(sessionKey);
  }

  /** Number of live (non-expired) entries — for tests/inspection only. */
  size(): number {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= this.now()) this.entries.delete(key);
    }
    return this.entries.size;
  }
}
