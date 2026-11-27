import { randomBytes, scryptSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  MAX_PIN_FAILURES_PER_CALL,
  normalizePin,
  PhoneStepUp,
  verifyPin,
  type PinStore,
} from "./step-up.js";

/** The console's hashPin (src/lib/voice/pin.ts), so the formats are checked against each other. */
function consoleHash(pin: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${scryptSync(pin, salt, 32).toString("base64")}`;
}

function setup(opts: { userId?: string | null; pin?: string | null; lockedAt?: string | null; claim?: () => Promise<number | null> } = {}) {
  let attempts = 0;
  const store: PinStore = {
    load: vi.fn(async () =>
      opts.pin === null ? null : { pinHash: consoleHash(opts.pin ?? "4421"), lockedAt: opts.lockedAt ?? null },
    ),
    claimAttempt: vi.fn(opts.claim ?? (async () => ++attempts)),
    clearFailures: vi.fn(async () => {
      attempts = 0;
    }),
  };
  const calls = new Map<string, { conversationId: string; userId: string | null }>([
    ["voice:19015550100", { conversationId: "call-1", userId: opts.userId === undefined ? "member" : opts.userId }],
  ]);
  const stepUp = new PhoneStepUp({ store, calls: { call: (k) => calls.get(k.replace(/^agent:main:/, "")) ?? null } });
  return { stepUp, store, calls };
}

describe("PIN format", () => {
  it("reads spoken digits and checks the console's scrypt records", () => {
    expect(normalizePin("4 4-2 1.")).toBe("4421");
    expect(normalizePin("12")).toBeNull();
    expect(normalizePin("four")).toBeNull();
    const stored = consoleHash("4421");
    expect(verifyPin("4421", stored)).toBe(true);
    expect(verifyPin("4422", stored)).toBe(false);
    expect(verifyPin("4421", "plain$x$y")).toBe(false);
    expect(verifyPin("4421", null)).toBe(false);
  });
});

describe("PhoneStepUp", () => {
  it("caller ID alone verifies nothing; the right PIN verifies this call only", async () => {
    const { stepUp, store, calls } = setup();
    expect(stepUp.isVerified("call-1")).toBe(false);
    const ok = await stepUp.verify("agent:main:voice:19015550100", "4421");
    expect(ok.ok).toBe(true);
    expect(stepUp.isVerified("call-1")).toBe(true);
    expect(store.clearFailures).toHaveBeenCalledWith("member");
    // The next call from the same number is a new conversation: asked again.
    calls.set("voice:19015550100", { conversationId: "call-2", userId: "member" });
    expect(stepUp.isVerified(stepUp.conversationFor("voice:19015550100"))).toBe(false);
  });

  it("a wrong PIN takes an attempt from the console's per-user count and doesn't verify", async () => {
    const { stepUp, store } = setup();
    const bad = await stepUp.verify("voice:19015550100", "0000");
    expect(bad.ok).toBe(false);
    expect(bad.text).toMatch(/isn't right/);
    expect(store.claimAttempt).toHaveBeenCalledWith("member", 5);
    expect(store.clearFailures).not.toHaveBeenCalled();
    expect(stepUp.isVerified("call-1")).toBe(false);
  });

  it("stops after a few wrong PINs on one call, even before the per-user lock", async () => {
    const { stepUp, store } = setup();
    for (let i = 0; i < MAX_PIN_FAILURES_PER_CALL; i++) await stepUp.verify("voice:19015550100", "0000");
    const after = await stepUp.verify("voice:19015550100", "4421");
    expect(after.ok).toBe(false);
    expect(after.text).toMatch(/Too many wrong PINs/);
    expect(store.claimAttempt).toHaveBeenCalledTimes(MAX_PIN_FAILURES_PER_CALL);
  });

  it("a locked PIN, or an attempt the console won't grant, refuses without checking", async () => {
    const locked = setup({ lockedAt: "2026-11-01T00:00:00Z" });
    expect((await locked.stepUp.verify("voice:19015550100", "4421")).ok).toBe(false);
    expect(locked.store.claimAttempt).not.toHaveBeenCalled();
    const exhausted = setup({ claim: async () => null });
    const r = await exhausted.stepUp.verify("voice:19015550100", "4421");
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/locked/);
    expect(exhausted.stepUp.isVerified("call-1")).toBe(false);
  });

  it("no member behind the number, no PIN on file, no call, or a malformed PIN: not verified", async () => {
    expect((await setup({ userId: null }).stepUp.verify("voice:19015550100", "4421")).ok).toBe(false);
    expect((await setup({ pin: null }).stepUp.verify("voice:19015550100", "4421")).ok).toBe(false);
    expect((await setup().stepUp.verify("voice:19015550999", "4421")).ok).toBe(false);
    const s = setup();
    expect((await s.stepUp.verify("voice:19015550100", "12")).ok).toBe(false);
    expect(s.store.claimAttempt).not.toHaveBeenCalled();
  });

  it("a PIN store that fails refuses (fail-closed)", async () => {
    const { stepUp } = setup({
      claim: async () => {
        throw new Error("rpc missing");
      },
    });
    const r = await stepUp.verify("voice:19015550100", "4421");
    expect(r.ok).toBe(false);
    expect(stepUp.isVerified("call-1")).toBe(false);
  });
});
