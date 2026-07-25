import { describe, expect, it } from "vitest";

import {
  CALLER_KIND_HEADER,
  CONVERSATION_ID_HEADER,
  DELEGATED_TURN_SYSTEM_NOTE,
  DELEGATION_CONNECTION_HEADER,
  DelegatedCredentialStore,
  credentialKeyNames,
  detectDelegatedTurn,
} from "./delegated-credentials.js";

describe("detectDelegatedTurn", () => {
  it("agent principal + X-Knox-Caller-Kind: agent + conversation id → delegated", () => {
    const turn = detectDelegatedTurn(
      { [CALLER_KIND_HEADER]: "agent", [DELEGATION_CONNECTION_HEADER]: "conn-1" },
      "agent",
      "conv-1",
    );
    expect(turn).toEqual({ delegated: true, conversationId: "conv-1", connectionId: "conn-1" });
  });

  it("spoofed header WITHOUT an agent principal → NOT delegated (no auth weakening)", () => {
    const turn = detectDelegatedTurn({ [CALLER_KIND_HEADER]: "agent" }, "user", "conv-1");
    expect(turn.delegated).toBe(false);
  });

  it("agent principal but caller-kind is not 'agent' → NOT delegated", () => {
    const turn = detectDelegatedTurn({ [CALLER_KIND_HEADER]: "user" }, "agent", "conv-1");
    expect(turn.delegated).toBe(false);
  });

  it("falls back to the X-Knox-Conversation-Id header when the path id is empty", () => {
    const turn = detectDelegatedTurn(
      { [CALLER_KIND_HEADER]: "agent", [CONVERSATION_ID_HEADER]: "conv-hdr" },
      "agent",
      "",
    );
    expect(turn.delegated).toBe(true);
    expect(turn.conversationId).toBe("conv-hdr");
  });

  it("no conversation id anywhere → NOT delegated", () => {
    expect(detectDelegatedTurn({ [CALLER_KIND_HEADER]: "agent" }, "agent", "").delegated).toBe(
      false,
    );
  });
});

describe("DelegatedCredentialStore", () => {
  it("set / get / clear round trip", () => {
    const store = new DelegatedCredentialStore();
    store.set("a2a:conv-1", { SPORTSINC_API_KEY: "v" });
    expect(store.get("a2a:conv-1")).toEqual({ SPORTSINC_API_KEY: "v" });
    store.clear("a2a:conv-1");
    expect(store.get("a2a:conv-1")).toEqual({});
  });

  it("isolates sessions — two concurrent delegations never see each other (the race case)", () => {
    const store = new DelegatedCredentialStore();
    store.set("a2a:conv-A", { SPORTSINC_API_KEY: "aaa" });
    store.set("a2a:conv-B", { SPORTSINC_API_KEY: "bbb" });
    expect(store.get("a2a:conv-A")).toEqual({ SPORTSINC_API_KEY: "aaa" });
    expect(store.get("a2a:conv-B")).toEqual({ SPORTSINC_API_KEY: "bbb" });
    // Clearing one turn leaves the other intact — no cross-turn leakage/override.
    store.clear("a2a:conv-A");
    expect(store.get("a2a:conv-A")).toEqual({});
    expect(store.get("a2a:conv-B")).toEqual({ SPORTSINC_API_KEY: "bbb" });
  });

  it("does not store empty credentials or an empty session key", () => {
    const store = new DelegatedCredentialStore();
    store.set("a2a:conv-1", {});
    store.set("", { SPORTSINC_API_KEY: "v" });
    expect(store.size()).toBe(0);
  });

  it("expires an entry after its TTL (backstop for a crashed turn)", () => {
    let now = 1000;
    const store = new DelegatedCredentialStore({ ttlMs: 100, now: () => now });
    store.set("a2a:conv-1", { SPORTSINC_API_KEY: "v" });
    expect(store.get("a2a:conv-1")).toEqual({ SPORTSINC_API_KEY: "v" });
    now = 1101;
    expect(store.get("a2a:conv-1")).toEqual({});
    expect(store.size()).toBe(0);
  });
});

describe("DelegatedCredentialStore.currentSingle (exec-shim, no session key)", () => {
  it("zero staged turns → {} (nothing to inject)", () => {
    expect(new DelegatedCredentialStore().currentSingle()).toEqual({});
  });

  it("exactly one staged turn → that turn's creds (the common case; turns serialize)", () => {
    const store = new DelegatedCredentialStore();
    store.set("a2a:conv-1", { SPORTSINC_API_KEY: "only-one" });
    expect(store.currentSingle()).toEqual({ SPORTSINC_API_KEY: "only-one" });
  });

  it("two concurrent staged turns → {} (FAIL-CLOSED: never guess which caller)", () => {
    const store = new DelegatedCredentialStore();
    store.set("a2a:conv-A", { SPORTSINC_API_KEY: "aaa" });
    store.set("a2a:conv-B", { SPORTSINC_API_KEY: "bbb" });
    expect(store.currentSingle()).toEqual({});
  });

  it("resolves back to the survivor once the other concurrent turn is cleared", () => {
    const store = new DelegatedCredentialStore();
    store.set("a2a:conv-A", { SPORTSINC_API_KEY: "aaa" });
    store.set("a2a:conv-B", { SPORTSINC_API_KEY: "bbb" });
    expect(store.currentSingle()).toEqual({});
    store.clear("a2a:conv-B");
    expect(store.currentSingle()).toEqual({ SPORTSINC_API_KEY: "aaa" });
  });

  it("ignores an expired entry — an expired + a live turn still reads as the single live one", () => {
    let now = 1000;
    const store = new DelegatedCredentialStore({ ttlMs: 100, now: () => now });
    store.set("a2a:stale", { SPORTSINC_API_KEY: "old" });
    now = 1101; // 'stale' is now past its TTL
    store.set("a2a:fresh", { SPORTSINC_API_KEY: "new" });
    expect(store.currentSingle()).toEqual({ SPORTSINC_API_KEY: "new" });
    expect(store.size()).toBe(1);
  });
});

describe("credentialKeyNames", () => {
  it("returns sorted key names only (never values)", () => {
    expect(credentialKeyNames({ B_KEY: "secret-b", A_KEY: "secret-a" })).toEqual([
      "A_KEY",
      "B_KEY",
    ]);
  });
});

describe("DELEGATED_TURN_SYSTEM_NOTE", () => {
  it("steers the model to run the skill via exec and NOT introspect for creds", () => {
    const note = DELEGATED_TURN_SYSTEM_NOTE;
    expect(note).toMatch(/exec/);
    // Names the exact wrong turns a weak model takes (see the gpt-4o logs).
    expect(note).toMatch(/get_my_bundle/);
    expect(note).toMatch(/get_delegated_credentials/);
    expect(note).toMatch(/sessions_spawn/);
  });

  it("is pure guidance — carries no credential VALUE (no KEY=value assignment)", () => {
    // The note may name tools/keys, but must never embed a secret value. Guard
    // against an accidental edit that pastes a `SOMETHING=<value>` pair in.
    expect(DELEGATED_TURN_SYSTEM_NOTE).not.toMatch(/[A-Z0-9_]+=\S/);
  });
});
