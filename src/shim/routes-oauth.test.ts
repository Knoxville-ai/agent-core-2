import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEnv } from "../env.js";
import { RefreshGate, type RevChange } from "../skills/refresh.js";
import type { Principal } from "./auth.js";
import type { OAuthSessionManager } from "./oauth-session.js";
import type { MessagingDB } from "./supabase-db.js";

vi.mock("../provision/oauth-store.js", () => ({ persistOAuthStore: vi.fn(async () => {}) }));

const { handleOAuthComplete } = await import("./routes-oauth.js");

const USER: Principal = { kind: "user", userId: "u1", email: null, role: null };

function req(body: unknown): IncomingMessage {
  const r = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (r as { headers: Record<string, string> }).headers = {};
  return r;
}

function res(): { res: ServerResponse; status: () => number } {
  let status = 0;
  const r = {
    writeHead(s: number) {
      status = s;
      return r;
    },
    end() {},
  } as unknown as ServerResponse;
  return { res: r, status: () => status };
}

let stateDir: string;
let writes: RevChange[][];
let gate: RefreshGate;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "knox-oauth-"));
  await writeFile(
    join(stateDir, "openclaw.json"),
    JSON.stringify({ gateway: { reload: { mode: "hot" } }, models: { providers: { openai: { apiKey: "sk" } } } }),
  );
  writes = [];
  gate = new RefreshGate(async (changes) => {
    writes.push(changes);
  });
  await gate.open(); // the vessel has been running: the gate is open
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function deps(gateway: { restart: () => Promise<void>; waitUntilReady: () => Promise<boolean> }) {
  return {
    env: { OPENCLAW_STATE_DIR: stateDir, AGENT_ORG: "acme", AGENT_UID: "0123456789abcdef" } as AgentEnv,
    db: { userInOrg: async () => true } as unknown as MessagingDB,
    sessions: { complete: async () => {} } as unknown as OAuthSessionManager,
    gateway,
    refreshGate: gate,
    refreshGateSettleMs: 0,
  };
}

describe("OAuth complete → in-process gateway restart holds skills refreshes", () => {
  it("closes the gate around the restart and reopens it (forced flush) once the new gateway is ready", async () => {
    let markReady!: (ok: boolean) => void;
    const readiness = new Promise<boolean>((r) => {
      markReady = r;
    });
    const seen: string[] = [];
    const gateway = {
      restart: async () => {
        seen.push(`restart: gate ${gate.isOpen ? "open" : "closed"}`);
        // A SkillSync refresh landing while the new child starts: must queue.
        seen.push(`push live=${(await gate.push([{ key: "beta", rev: "111111111111" }])).live}`);
      },
      waitUntilReady: () => readiness,
    };
    const { res: r, status } = res();

    await handleOAuthComplete(USER, req({ callbackUrl: "http://localhost:1455/cb?code=x" }), r, deps(gateway));

    expect(status()).toBe(200);
    expect(seen).toEqual(["restart: gate closed", "push live=false"]);
    expect(gate.isOpen).toBe(false);
    expect(writes).toEqual([]); // nothing written while the new gateway isn't watching

    markReady(true);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual([{ key: "beta", rev: "111111111111" }]);
    expect(gate.isOpen).toBe(true);
    // The config flip still happened (serialized with rev bumps).
    const config = JSON.parse(await readFile(join(stateDir, "openclaw.json"), "utf8"));
    expect(config.auth?.order?.openai).toEqual(["openai-codex:default"]);
    expect(config.models).toBeUndefined();
  });

  it("forces a refresh after the restart even when nothing queued", async () => {
    const gateway = { restart: async () => {}, waitUntilReady: async () => true };
    await handleOAuthComplete(USER, req({ callbackUrl: "http://localhost:1455/cb?code=x" }), res().res, deps(gateway));
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual([{ key: "knox-skillsync", rev: expect.stringMatching(/^[0-9a-f]{12}$/) }]);
  });

  it("reopens the gate even when the restart fails", async () => {
    const gateway = {
      restart: async () => {
        throw new Error("spawn failed");
      },
      waitUntilReady: async () => false,
    };
    await expect(
      handleOAuthComplete(USER, req({ callbackUrl: "http://localhost:1455/cb?code=x" }), res().res, deps(gateway)),
    ).rejects.toThrow("spawn failed");
    await vi.waitFor(() => expect(gate.isOpen).toBe(true));
  });
});
