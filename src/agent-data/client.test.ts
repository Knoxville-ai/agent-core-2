import { describe, expect, it, vi } from "vitest";

import { loadEnv, type AgentEnv } from "../env.js";
import { AgentStorage } from "../provision/supabase-storage.js";
import { MessagingDB } from "../shim/supabase-db.js";
import { ConsoleTurnPublisher } from "../shim/turn-live.js";
import { ScopedCallMirrorStore } from "../voice/call-mirror.js";
import { AgentDataCallError, AgentDataClient, resolveDataAccess } from "./client.js";
import { ScopedMessaging } from "./messaging.js";

const DATA_URL = "https://console.test/api/mcp/agent-data";
const TOKEN = "knox_agent_test_token";

const BASE = {
  AGENT_UID: "560bd7e31e229d1d",
  AGENT_ORG: "bacon-company",
  SUPABASE_URL: "https://example.supabase.co",
  OPENCLAW_GATEWAY_TOKEN: "gateway-token-at-least-16-chars",
  LLM_PROVIDER: "openrouter",
  LLM_MODEL: "qwen/qwen3.7-plus",
};

function envWith(over: Record<string, string>): AgentEnv {
  const saved = process.env;
  process.env = { ...BASE, ...over } as NodeJS.ProcessEnv;
  try {
    return loadEnv();
  } finally {
    process.env = saved;
  }
}

/** A fetch that answers agent data ops from `handlers` and records each call. */
function fakeApi(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: Array<{ op: string; args: Record<string, unknown>; auth: string | null }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://signed.test/")) {
      if (url.endsWith("/missing")) return new Response("", { status: 404 });
      return new Response(`body of ${url.slice("https://signed.test/".length)}`);
    }
    const { op, ...args } = JSON.parse(String(init?.body)) as { op: string } & Record<string, unknown>;
    calls.push({ op, args, auth: new Headers(init?.headers).get("authorization") });
    const handler = handlers[op];
    if (!handler) return Response.json({ ok: false, error: "conversation not found" }, { status: 404 });
    return Response.json({ ok: true, result: handler(args) });
  });
  const client = new AgentDataClient({ url: DATA_URL, token: TOKEN, fetchImpl: fetchImpl as typeof fetch });
  return { client, calls, fetchImpl };
}

describe("env", () => {
  it("boots without the database key when the console provides the agent data API", () => {
    const env = envWith({ PLATFORM_AGENT_DATA_URL: DATA_URL, PLATFORM_API_TOKEN: TOKEN });
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe("");
    expect(env.PLATFORM_AGENT_DATA_URL).toBe(DATA_URL);
  });

  it("still requires the key when there is no agent data API", () => {
    expect(() => envWith({})).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(() => envWith({ PLATFORM_AGENT_DATA_URL: DATA_URL })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe("resolveDataAccess", () => {
  const hello = (org = BASE.AGENT_ORG, uid = BASE.AGENT_UID) => ({ hello: () => ({ org_id: org, agent_uid: uid }) });

  it("uses the scoped API and drops platform-wide credentials from the inherited environment", async () => {
    const env = envWith({ PLATFORM_AGENT_DATA_URL: DATA_URL, PLATFORM_API_TOKEN: TOKEN, SUPABASE_SERVICE_ROLE_KEY: "svc" });
    const processEnv: NodeJS.ProcessEnv = {
      SUPABASE_SERVICE_ROLE_KEY: "svc",
      GOOGLE_CSE_API_KEY: "cse",
      GOOGLE_CSE_ID: "id",
      KEEP_ME: "1",
    };
    const { client, calls } = fakeApi(hello());
    await expect(resolveDataAccess(env, processEnv, () => client)).resolves.toBe("scoped");
    expect(calls.map((c) => c.op)).toEqual(["hello"]);
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe("");
    expect(processEnv).toEqual({ KEEP_ME: "1" });
  });

  it("falls back to the key while it is present and the API does not answer", async () => {
    const env = envWith({ PLATFORM_AGENT_DATA_URL: DATA_URL, PLATFORM_API_TOKEN: TOKEN, SUPABASE_SERVICE_ROLE_KEY: "svc" });
    const processEnv: NodeJS.ProcessEnv = { SUPABASE_SERVICE_ROLE_KEY: "svc" };
    const { client } = fakeApi({});
    await expect(resolveDataAccess(env, processEnv, () => client)).resolves.toBe("service-key");
    expect(env.PLATFORM_AGENT_DATA_URL).toBeUndefined();
    expect(processEnv.SUPABASE_SERVICE_ROLE_KEY).toBe("svc");
  });

  it("refuses to start with neither a working API nor a key", async () => {
    const env = envWith({ PLATFORM_AGENT_DATA_URL: DATA_URL, PLATFORM_API_TOKEN: TOKEN });
    await expect(resolveDataAccess(env, {}, () => fakeApi({}).client)).rejects.toThrow(/no database key/);
  });

  it("does not accept a token that the console reports as another agent's", async () => {
    const env = envWith({ PLATFORM_AGENT_DATA_URL: DATA_URL, PLATFORM_API_TOKEN: TOKEN });
    await expect(
      resolveDataAccess(env, {}, () => fakeApi(hello("other-org", "0000000000000000")).client),
    ).rejects.toThrow(/different agent/);
  });

  it("keeps the key path when the console offers no API", async () => {
    const env = envWith({ SUPABASE_SERVICE_ROLE_KEY: "svc" });
    await expect(resolveDataAccess(env, {})).resolves.toBe("service-key");
  });
});

describe("AgentDataClient", () => {
  it("raises the console's refusal with its status", async () => {
    const { client } = fakeApi({});
    const err = await client.call("messages.list", { conversation_id: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentDataCallError);
    expect((err as AgentDataCallError).status).toBe(404);
  });
});

describe("scoped data paths", () => {
  const scopedEnv = () => envWith({ PLATFORM_AGENT_DATA_URL: DATA_URL, PLATFORM_API_TOKEN: TOKEN });

  it("MessagingDB never builds a database client and sends no identity of its own", async () => {
    const { client, calls } = fakeApi({
      "conversation.get": () => ({ conversation: null }),
      "messages.insert": () => ({ id: "m1" }),
      "messages.fail_orphaned": () => ({ count: 2 }),
      "tool_calls.insert": () => ({ id: "t1" }),
    });
    const db = new MessagingDB(scopedEnv(), undefined, new ScopedMessaging(client));
    expect(await db.getConversation("c1")).toBeNull();
    expect(
      await db.insertMessage({ conversationId: "c1", role: "assistant", senderKind: "agent", senderId: BASE.AGENT_UID }),
    ).toBe("m1");
    expect(await db.failOrphanedTurns(BASE.AGENT_UID)).toBe(2);
    expect(
      await db.insertToolCall({
        orgId: BASE.AGENT_ORG,
        agentUid: BASE.AGENT_UID,
        conversationId: "c1",
        messageId: null,
        taskId: null,
        seq: 0,
        toolName: "exec",
        server: null,
        toolCallId: null,
        argsPreview: null,
      }),
    ).toBe("t1");
    // A refused or failed call degrades the same way the key path does.
    expect(await db.listMessages("c1")).toEqual([]);
    expect(await db.userInOrg("u1", BASE.AGENT_ORG)).toBe(false);
    for (const c of calls) {
      expect(c.args).not.toHaveProperty("org_id");
      expect(c.args).not.toHaveProperty("agent_uid");
    }
    expect(calls.find((c) => c.op === "messages.insert")?.args).toMatchObject({
      conversation_id: "c1",
      role: "assistant",
      sender_kind: "agent",
    });
  });

  it("MessagingDB built from a scoped env works without SUPABASE_SERVICE_ROLE_KEY", () => {
    expect(() => new MessagingDB(scopedEnv())).not.toThrow();
    expect(() => new AgentStorage(scopedEnv())).not.toThrow();
  });

  it("downloads attachments through a signed URL", async () => {
    const { client, calls } = fakeApi({
      "attachments.sign": (a) => ({ url: a.storage_path === "gone" ? null : "https://signed.test/cat.png" }),
    });
    const scoped = new ScopedMessaging(client);
    const b64 = await scoped.downloadAttachmentBase64("orgs/bacon-company/conversations/c1/cat.png");
    expect(Buffer.from(b64!, "base64").toString()).toBe("body of cat.png");
    expect(await scoped.downloadAttachmentBase64("gone")).toBeNull();
    expect(calls.map((c) => c.op)).toEqual(["attachments.sign", "attachments.sign"]);
  });

  it("AgentStorage sends paths relative to the agent's own prefix", async () => {
    const { client, calls } = fakeApi({
      "storage.sign": (a) => ({ url: a.path === "memory/none.md" ? null : `https://signed.test/${String(a.path)}` }),
      "storage.shared.sign": () => ({ url: "https://signed.test/missing" }),
      "storage.upload": () => ({}),
      "storage.list": () => ({ names: ["a.md"] }),
      "storage.remove": () => ({}),
    });
    const storage = new AgentStorage(scopedEnv(), client);
    expect(await storage.downloadText("/memory/playbook.md")).toBe("body of memory/playbook.md");
    expect(await storage.downloadText("memory/none.md")).toBeNull();
    expect(await storage.downloadShared("platform/constitution.md")).toBeNull();
    await storage.uploadJSON("manifest.json", { a: 1 });
    expect(await storage.list("state/notes/")).toEqual(["a.md"]);
    await storage.remove("state/notes/a.md");
    expect(calls.map((c) => [c.op, c.args.path ?? c.args.key])).toEqual([
      ["storage.sign", "memory/playbook.md"],
      ["storage.sign", "memory/none.md"],
      ["storage.shared.sign", "platform/constitution.md"],
      ["storage.upload", "manifest.json"],
      ["storage.list", "state/notes"],
      ["storage.remove", "state/notes/a.md"],
    ]);
    expect(calls.find((c) => c.op === "storage.upload")?.args.content_type).toBe("application/json");
  });

  it("an upload the console refuses is an error, not a silent success", async () => {
    const { client } = fakeApi({});
    await expect(new AgentStorage(scopedEnv(), client).uploadText("x.md", "x", "text/markdown")).rejects.toThrow(
      /storage upload failed/,
    );
  });

  it("phone calls: the console matches the member and fills in this agent's identity", async () => {
    const { client, calls } = fakeApi({
      "members.find_by_phone": () => ({ member: { user_id: "u1", name: "Ann" } }),
      "conversation.create_phone": () => ({ id: "c9" }),
      "messages.insert": () => ({ id: "m9" }),
      "memories.remember": () => ({}),
      "agent.display_name": () => ({ display_name: " Sales " }),
    });
    const store = new ScopedCallMirrorStore(client);
    expect(await store.findMemberByPhone("15550102000")).toEqual({ userId: "u1", name: "Ann" });
    expect(await store.findMemberByPhone("123")).toBeNull();
    expect(await store.createConversation({ userId: "u1", title: "Call" })).toBe("c9");
    await store.insertMessage({ conversationId: "c9", role: "user", content: "hi", senderKind: "user", senderId: null, at: 0 });
    await store.remember({ conversationId: "c9", body: "called", tags: ["phone"] });
    expect(await store.agentDisplayName()).toBe("Sales");
    expect(calls.find((c) => c.op === "messages.insert")?.args.created_at).toBe(new Date(0).toISOString());
    for (const c of calls) expect(c.args).not.toHaveProperty("p_org_id");
  });
});

describe("ConsoleTurnPublisher", () => {
  it("keeps one request in flight per topic and sends what queued meanwhile together, in order", async () => {
    const batches: Array<{ conversation_id: unknown; events: Array<{ type: string; delta?: string }> }> = [];
    let release!: () => void;
    let gate = new Promise<void>((r) => (release = r));
    const api = {
      call: vi.fn(async (_op: string, args: Record<string, unknown>) => {
        batches.push(args as never);
        await gate;
        return {};
      }),
    } as unknown as AgentDataClient;
    const pub = new ConsoleTurnPublisher(api);
    await pub.publish("conversation:c1", [{ type: "start", message_id: "m1", user_message_id: "u1" }]);
    await pub.publish("conversation:c1", [{ type: "token", message_id: "m1", offset: 0, delta: "a" }]);
    await pub.publish("conversation:c1", [{ type: "token", message_id: "m1", offset: 1, delta: "b" }]);
    const done = pub.publish("conversation:c1", [{ type: "done", message_id: "m1", status: "complete" }]);
    expect(batches).toHaveLength(1);
    gate = Promise.resolve();
    release();
    await done;
    expect(batches.map((b) => b.events.map((e) => e.delta ?? e.type))).toEqual([
      ["start"],
      ["a", "b", "done"],
    ]);
    expect(batches.every((b) => b.conversation_id === "c1")).toBe(true);
  });

  it("never lets a delivery failure escape", async () => {
    const api = { call: vi.fn(async () => Promise.reject(new Error("down"))) } as unknown as AgentDataClient;
    const pub = new ConsoleTurnPublisher(api);
    await pub.publish("conversation:c1", [{ type: "start", message_id: "m1", user_message_id: "u1" }]);
    await expect(
      pub.publish("conversation:c1", [{ type: "done", message_id: "m1", status: "error" }]),
    ).resolves.toBeUndefined();
  });
});
