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

interface StoreEntry {
  creds: DelegatedCredentials;
  expiresAt: number;
}

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

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000; // 10 min backstop
    this.now = opts.now ?? ((): number => Date.now());
  }

  /** Store the creds for a session's current turn. Empty maps and empty session
   *  keys are ignored (nothing to expose). */
  set(sessionKey: string, creds: DelegatedCredentials): void {
    if (!sessionKey || Object.keys(creds).length === 0) return;
    this.entries.set(sessionKey, { creds, expiresAt: this.now() + this.ttlMs });
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

  /** Drop a session's creds — called when the turn ends. Idempotent. */
  clear(sessionKey: string): void {
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
