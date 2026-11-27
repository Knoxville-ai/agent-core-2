import { scryptSync, timingSafeEqual } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";

/**
 * Step-up verification on a phone call (SEC-021).
 *
 * Who is calling is first known only from caller ID (call-mirror.ts matches
 * the number to a member), which is not proof of identity. So a call starts with the
 * restricted toolset (session-policy.ts, channel "phone") and the owner's tools
 * open only once the caller says the phone PIN of the member the call is filed
 * under. The PIN is the console's (0218): a salted scrypt hash in
 * `user_phone_pins`, with the console's per-user lockout (0270) shared through
 * its `claim_phone_pin_attempt` / `clear_phone_pin_failures` functions, so
 * wrong PINs here and on an approval count against the same limit.
 *
 * Verification belongs to one call: it is recorded against the call's console
 * conversation (a new one per call), never the caller's number, so the next
 * call from the same number starts unverified again. It lives in this process
 * only; after a restart the caller is asked again.
 */

/** Same rules as the console's src/lib/voice/pin.ts. */
export const PIN_RE = /^\d{4,8}$/;
/** Wrong PINs in a row for one user, across calls and escalations (console 0270). */
export const MAX_PIN_FAILURES_PER_USER = 5;
/** Wrong PINs on one call before it can't be verified any more. */
export const MAX_PIN_FAILURES_PER_CALL = 3;

/** Spoken digits → a PIN: "4 4-2 1" / "4421." → "4421"; anything else null. */
export function normalizePin(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/[\s.,-]/g, "");
  return PIN_RE.test(digits) ? digits : null;
}

/** Check a PIN against a console `scrypt$<salt>$<hash>` record. */
export function verifyPin(pin: string, stored: string | null | undefined): boolean {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "base64");
  const expected = Buffer.from(parts[2]!, "base64");
  if (salt.length === 0 || expected.length !== 32) return false;
  const actual = scryptSync(pin, salt, 32);
  return timingSafeEqual(actual, expected);
}

/** The console's PIN records, read with the service role. */
export interface PinStore {
  load(userId: string): Promise<{ pinHash: string; lockedAt: string | null } | null>;
  /** Take one attempt atomically; the attempt's number, or null when locked / no PIN. */
  claimAttempt(userId: string, max: number): Promise<number | null>;
  clearFailures(userId: string): Promise<void>;
}

/** The call a voice session is on, as the call mirror knows it. */
export interface CallLookup {
  /** The call's console conversation and the member it is filed under. */
  call(sessionKey: string): { conversationId: string; userId: string | null } | null;
}

export type StepUpResult = { ok: boolean; text: string };

export class PhoneStepUp {
  private readonly verified = new Set<string>();
  private readonly callFailures = new Map<string, number>();

  constructor(
    private readonly deps: { store: PinStore; calls: CallLookup },
  ) {}

  /** Has the caller on this call's conversation confirmed their PIN? */
  isVerified(conversationId: string | null | undefined): boolean {
    return !!conversationId && this.verified.has(conversationId);
  }

  /** The call conversation behind a voice session key, if the mirror has linked it. */
  conversationFor(sessionKey: string): string | null {
    return this.deps.calls.call(sessionKey)?.conversationId ?? null;
  }

  async verify(sessionKey: string, rawPin: unknown): Promise<StepUpResult> {
    const call = this.deps.calls.call(sessionKey);
    if (!call) {
      return { ok: false, text: "This only works on a live phone call, once it's connected. Try again in a moment." };
    }
    if (this.verified.has(call.conversationId)) return { ok: true, text: "The caller is already verified on this call." };
    if (!call.userId) {
      return {
        ok: false,
        text:
          "The caller's number isn't on any member's profile or the agent's caller list, so there is no PIN to " +
          "check. You can answer their questions, but you can't act for them on this call.",
      };
    }
    const failures = this.callFailures.get(call.conversationId) ?? 0;
    if (failures >= MAX_PIN_FAILURES_PER_CALL) {
      return { ok: false, text: "Too many wrong PINs on this call. The caller can't be verified on it any more." };
    }
    const pin = normalizePin(rawPin);
    // No well-formed PIN can't be right, so it costs no attempt.
    if (!pin) return { ok: false, text: "Ask the caller for their phone PIN (4 to 8 digits) and try again." };

    let stored: { pinHash: string; lockedAt: string | null } | null;
    try {
      stored = await this.deps.store.load(call.userId);
    } catch (err) {
      log.warn("phone PIN lookup failed", { err: String(err) });
      return { ok: false, text: "The PIN can't be checked right now. Try again shortly." };
    }
    if (!stored) {
      return {
        ok: false,
        text: "The caller hasn't set a phone PIN (Settings → Profile in the console), so they can't be verified by phone.",
      };
    }
    if (stored.lockedAt) {
      return {
        ok: false,
        text: "Phone verification is locked for this caller after too many wrong PINs. They can set a new PIN in Settings → Profile.",
      };
    }
    let attempt: number | null;
    try {
      attempt = await this.deps.store.claimAttempt(call.userId, MAX_PIN_FAILURES_PER_USER);
    } catch (err) {
      log.warn("phone PIN attempt not claimed", { err: String(err) });
      return { ok: false, text: "The PIN can't be checked right now. Try again shortly." };
    }
    if (typeof attempt !== "number") {
      return {
        ok: false,
        text: "Phone verification is locked for this caller after too many wrong PINs. They can set a new PIN in Settings → Profile.",
      };
    }
    if (!verifyPin(pin, stored.pinHash)) {
      this.callFailures.set(call.conversationId, failures + 1);
      log.warn("phone PIN rejected", { conversation_id: call.conversationId, attempt });
      const left = Math.min(MAX_PIN_FAILURES_PER_CALL - failures - 1, MAX_PIN_FAILURES_PER_USER - attempt);
      return {
        ok: false,
        text: left > 0 ? `That PIN isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "That PIN isn't right, and that was the last try.",
      };
    }
    await this.deps.store.clearFailures(call.userId).catch((err) => {
      log.warn("phone PIN failures not cleared", { err: String(err) });
    });
    this.verified.add(call.conversationId);
    this.callFailures.delete(call.conversationId);
    log.info("phone caller verified", { conversation_id: call.conversationId });
    return { ok: true, text: "PIN confirmed: the caller is verified for the rest of this call." };
  }
}

/** The console's PIN tables, through the service role (same client as the call mirror). */
export class SupabasePinStore implements PinStore {
  private readonly client: SupabaseClient;

  constructor(env: AgentEnv, client?: SupabaseClient) {
    this.client =
      client ??
      createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
  }

  async load(userId: string): Promise<{ pinHash: string; lockedAt: string | null } | null> {
    const { data, error } = await this.client
      .from("user_phone_pins")
      .select("pin_hash, locked_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(`user_phone_pins: ${error.message}`);
    const row = data as { pin_hash: string; locked_at: string | null } | null;
    return row ? { pinHash: row.pin_hash, lockedAt: row.locked_at ?? null } : null;
  }

  async claimAttempt(userId: string, max: number): Promise<number | null> {
    const { data, error } = await this.client.rpc("claim_phone_pin_attempt", { p_user_id: userId, p_max: max });
    if (error) throw new Error(`claim_phone_pin_attempt: ${error.message}`);
    if (typeof data === "number") return data;
    // A set-returning sql function may come back as [{ failed_attempts }] or [n].
    if (Array.isArray(data) && data.length > 0) {
      const v = data[0] as unknown;
      if (typeof v === "number") return v;
      const n = (v as { claim_phone_pin_attempt?: unknown; failed_attempts?: unknown } | null);
      const x = n?.claim_phone_pin_attempt ?? n?.failed_attempts;
      return typeof x === "number" ? x : null;
    }
    return null;
  }

  async clearFailures(userId: string): Promise<void> {
    const { error } = await this.client.rpc("clear_phone_pin_failures", { p_user_id: userId });
    if (error) throw new Error(`clear_phone_pin_failures: ${error.message}`);
  }
}
