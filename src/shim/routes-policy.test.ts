import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentEnv } from "../env.js";
import { PhoneStepUp } from "../voice/step-up.js";
import { HttpError } from "./auth.js";
import { routePolicy, sessionIdsFor, type PolicyRuntime } from "./routes-policy.js";
import { bootMemoryDigest } from "./session-policy.js";
import { SessionPolicyService, type ConversationRow, type SessionTrustStore } from "./session-policy-service.js";

const AGENT = "0123456789abcdef";
const TOKEN = "gateway-token-0123456789";
const env = { OPENCLAW_GATEWAY_TOKEN: TOKEN, AGENT_UID: AGENT } as AgentEnv;

const rows: Record<string, ConversationRow> = {
  anon: { id: "anon", org_id: "acme", agent_uid: AGENT, user_id: null, origin: "web", caller_agent_uid: null, delegation_connection_id: null, drive_through_connection_id: null },
  mine: { id: "mine", org_id: "acme", agent_uid: AGENT, user_id: "member", origin: "web", caller_agent_uid: null, delegation_connection_id: null, drive_through_connection_id: null },
};
const store: SessionTrustStore = {
  conversation: async (id) => rows[id] ?? null,
  isMember: async (_o, u) => u === "member",
  agentOrg: async () => "acme",
  latestInboundEmail: async () => null,
  userAddresses: async () => [],
  task: async () => null,
  optIns: async () => new Set(),
};

function runtime(): PolicyRuntime {
  const phone = new PhoneStepUp({
    store: { load: async () => null, claimAttempt: async () => null, clearFailures: async () => {} },
    calls: { call: (k) => (k.includes("voice:1901") ? { conversationId: "call-1", userId: null } : null) },
  });
  return {
    phone,
    policy: new SessionPolicyService({ agentUid: AGENT, agentOrg: "acme", store, phone, servers: ["odoo"], workspaceDir: "/ws" }),
  };
}

const servers: Server[] = [];
afterEach(async () => {
  bootMemoryDigest.current = null;
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

async function start(rt: PolicyRuntime): Promise<string> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    routePolicy(url.pathname, req.method ?? "GET", url, req, res, env, rt)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      })
      .catch((err) => {
        res.writeHead(err instanceof HttpError ? err.status : 500);
        res.end();
      });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function ask(base: string, body: unknown) {
  const res = await fetch(`${base}/internal/tool-policy`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as { allow: boolean; reason?: string } };
}

describe("POST /internal/tool-policy", () => {
  it("refuses an anonymous public chat's exec and list_my_tasks; allows a member's", async () => {
    const base = await start(runtime());
    for (const tool of ["exec", "knoxville_platform__list_my_tasks"]) {
      const r = await ask(base, { session_key: "webchat:anon", tool_name: tool, params: {} });
      expect(r.body.allow, tool).toBe(false);
      expect(r.body.reason).toMatch(/outside your organization/);
      expect((await ask(base, { session_key: "webchat:mine", tool_name: tool, params: {} })).body.allow).toBe(true);
    }
  });

  it("a phone caller who hasn't said their PIN can't start work", async () => {
    const base = await start(runtime());
    const r = await ask(base, { session_key: "voice:19015550100", tool_name: "knoxville_platform__start_task", params: {} });
    expect(r.body.allow).toBe(false);
    expect(r.body.reason).toMatch(/verify_caller_pin/);
  });

  it("requires the gateway token", async () => {
    const base = await start(runtime());
    const res = await fetch(`${base}/internal/tool-policy`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });
});

describe("GET /internal/session-context", () => {
  it("gives the boot memory digest to trusted sessions only", async () => {
    bootMemoryDigest.current = "- the CFO prefers net-30";
    const base = await start(runtime());
    const get = async (key: string) =>
      (await (
        await fetch(`${base}/internal/session-context?session_key=${encodeURIComponent(key)}`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
      ).json()) as { channel: string; memory_digest?: string };
    expect(await get("webchat:mine")).toEqual({ channel: "trusted", memory_digest: "- the CFO prefers net-30" });
    expect(await get("webchat:anon")).toEqual({ channel: "public" });
    expect(await get("voice:19015550100")).toEqual({ channel: "phone" });
  });
});

describe("POST /internal/voice-step-up", () => {
  it("only answers for phone sessions", async () => {
    const base = await start(runtime());
    const post = async (body: unknown) =>
      (await (
        await fetch(`${base}/internal/voice-step-up`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json()) as { ok: boolean; text: string };
    expect((await post({ session_key: "webchat:mine", pin: "4421" })).ok).toBe(false);
    // Unknown number: no member to check a PIN for.
    const r = await post({ session_key: "voice:19015550100", pin: "4421" });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/isn't on any member's profile/);
  });
});

describe("sessionIdsFor", () => {
  it("maps a stamped session key to the console's session ids", () => {
    const rt = runtime();
    expect(sessionIdsFor(rt, "webchat:c1")).toEqual({ conversationId: "c1", taskId: null });
    expect(sessionIdsFor(rt, "agent:main:a2a:c2")).toEqual({ conversationId: "c2", taskId: null });
    expect(sessionIdsFor(rt, "task:t1")).toEqual({ conversationId: null, taskId: "t1" });
    expect(sessionIdsFor(rt, "voice:19015550100")).toEqual({ conversationId: "call-1", taskId: null });
    expect(sessionIdsFor(rt, "agent:main:main")).toEqual({ conversationId: null, taskId: null });
  });
});
