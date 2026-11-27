import { describe, expect, it, vi } from "vitest";

import { isWithheldFromChildren } from "../openclaw/child-env.js";

import {
  directServerNames,
  parseEnvOptIns,
  SessionPolicyService,
  type ConversationRow,
  type SessionTrustStore,
} from "./session-policy-service.js";

const AGENT = "0123456789abcdef";
const WS = "/home/agent/.openclaw/workspace";

function conv(over: Partial<ConversationRow>): ConversationRow {
  return {
    id: "c1",
    org_id: "acme",
    agent_uid: AGENT,
    user_id: null,
    origin: null,
    caller_agent_uid: null,
    delegation_connection_id: null,
    drive_through_connection_id: null,
    ...over,
  };
}

function store(over: Partial<SessionTrustStore> & { rows?: Record<string, ConversationRow> } = {}): SessionTrustStore {
  const rows = over.rows ?? {};
  return {
    conversation: async (id) => rows[id] ?? null,
    isMember: async (_org, userId) => userId === "member",
    agentOrg: async () => "acme",
    latestInboundEmail: async () => null,
    userAddresses: async () => [],
    task: async () => null,
    optIns: async () => new Set(),
    ...over,
  };
}

function service(s: SessionTrustStore, extra: Partial<ConstructorParameters<typeof SessionPolicyService>[0]> = {}) {
  return new SessionPolicyService({
    agentUid: AGENT,
    agentOrg: "acme",
    store: s,
    servers: ["odoo"],
    workspaceDir: WS,
    ...extra,
  });
}

describe("SessionPolicyService", () => {
  it("an anonymous public chat can't run exec, list tasks or reach a connector; a member's chat can", async () => {
    const svc = service(
      store({
        rows: {
          anon: conv({ id: "anon", origin: "web" }),
          mine: conv({ id: "mine", origin: "web", user_id: "member" }),
        },
      }),
    );
    for (const tool of ["exec", "knoxville_platform__list_my_tasks", "knoxville_platform__recall", "odoo__create_bill"]) {
      const { decision, session } = await svc.decide("webchat:anon", tool, {});
      expect(session.channel).toBe("public");
      expect(decision.allow, tool).toBe(false);
    }
    for (const tool of ["exec", "knoxville_platform__list_my_tasks", "odoo__create_bill"]) {
      const { decision } = await svc.decide("webchat:mine", tool, {});
      expect(decision.allow, tool).toBe(true);
    }
  });

  it("an email from an open address is untrusted; one the address vouches for isn't", async () => {
    const rows = { e1: conv({ id: "e1", origin: "email" }), e2: conv({ id: "e2", origin: "email" }) };
    const svc = service(
      store({
        rows,
        latestInboundEmail: async (id) =>
          id === "e1" ? { fromEmail: "x@y.z", inboundPolicy: "open" } : { fromEmail: "x@y.z", inboundPolicy: "members" },
      }),
    );
    expect((await svc.session("webchat:e1")).channel).toBe("email");
    expect((await svc.session("webchat:e2")).channel).toBe("trusted");
  });

  it("an SMS conversation is public even with a member on it", async () => {
    const svc = service(store({ rows: { s: conv({ id: "s", origin: "sms", user_id: "member" }) } }));
    expect((await svc.session("webchat:s")).channel).toBe("public");
  });

  it("a task is judged by its conversation", async () => {
    const svc = service(
      store({
        rows: { anon: conv({ id: "anon", origin: "mcp" }) },
        task: async (id) => (id === "t1" ? { agentUid: AGENT, conversationId: "anon" } : { agentUid: AGENT, conversationId: null }),
      }),
    );
    expect(await svc.session("task:t1")).toEqual({ channel: "public", conversationId: "anon", taskId: "t1" });
    expect((await svc.session("task:t2")).channel).toBe("trusted");
  });

  it("a lookup that fails, or another agent's conversation, is untrusted", async () => {
    const failing = service(
      store({
        conversation: async () => {
          throw new Error("db down");
        },
        task: async () => {
          throw new Error("db down");
        },
      }),
    );
    expect((await failing.session("webchat:c1")).channel).toBe("public");
    expect((await failing.session("task:t1")).channel).toBe("public");
    const other = service(store({ rows: { c1: conv({ agent_uid: "fedcba9876543210", user_id: "member" }) } }));
    expect((await other.session("webchat:c1")).channel).toBe("public");
    expect((await other.session("webchat:missing")).channel).toBe("public");
  });

  it("a phone call is restricted until its caller is verified, and verification is per call", async () => {
    const verified = new Set<string>();
    const phone = {
      conversationFor: (key: string) => (key.endsWith("voice:19015550100") ? "call-1" : null),
      isVerified: (id: string | null | undefined) => !!id && verified.has(id),
    };
    const svc = service(
      store({ rows: { "call-1": conv({ id: "call-1", origin: "phone", user_id: "member" }) } }),
      { phone },
    );
    expect((await svc.session("agent:main:voice:19015550100")).channel).toBe("phone");
    expect((await svc.decide("voice:19015550100", "knoxville_platform__start_task", {})).decision.allow).toBe(false);
    expect((await svc.decide("voice:19015550100", "exec", {})).decision.allow).toBe(false);
    // The call's console conversation (where results land) follows the call.
    expect((await svc.session("webchat:call-1")).channel).toBe("phone");
    verified.add("call-1");
    expect((await svc.session("voice:19015550100")).channel).toBe("trusted");
    expect((await svc.decide("voice:19015550100", "knoxville_platform__start_task", {})).decision.allow).toBe(true);
    expect((await svc.session("webchat:call-1")).channel).toBe("trusted");
    // No mirrored call yet: restricted.
    expect((await svc.session("voice:19015550199")).channel).toBe("phone");
  });

  it("a conversation the call mirror made is a phone call whatever the store says", async () => {
    const phone = {
      conversationFor: () => null,
      isVerified: () => false,
      isPhoneConversation: (id: string) => id === "call-9",
    };
    const svc = service(store({ rows: { "call-9": conv({ id: "call-9", user_id: "member" }) } }), { phone });
    expect((await svc.session("webchat:call-9")).channel).toBe("phone");
  });

  it("sessions the runtime didn't open are the agent's own", async () => {
    const svc = service(store());
    expect((await svc.session("agent:main:main")).channel).toBe("trusted");
    expect((await svc.session(null)).channel).toBe("trusted");
  });

  it("honors the console's per-agent opt-ins and the operator's", async () => {
    const optIns = vi.fn(async (_a: string, channel: string) => new Set(channel === "public" ? ["Exec"] : []));
    const svc = service(store({ rows: { anon: conv({ id: "anon", origin: "web" }) }, optIns }), {
      envOptIns: "public:web_fetch, email:write, knoxville_platform__get_skill",
    });
    expect((await svc.decide("webchat:anon", "exec", {})).decision.allow).toBe(true);
    expect((await svc.decide("webchat:anon", "write", { path: "x" })).decision.allow).toBe(false);
    expect((await svc.decide("webchat:anon", "knoxville_platform__get_skill", {})).decision.allow).toBe(true);
    expect(optIns).toHaveBeenCalledTimes(1);
  });

  it("audit mode allows what it would refuse; off allows everything", async () => {
    const s = store({ rows: { anon: conv({ id: "anon", origin: "web" }) } });
    expect((await service(s, { mode: "audit" }).decide("webchat:anon", "exec", {})).decision.allow).toBe(true);
    expect((await service(s, { mode: "off" }).decide("webchat:anon", "exec", {})).decision.allow).toBe(true);
    expect((await service(s).decide("webchat:anon", "exec", {})).decision.allow).toBe(false);
  });

  it("caches a conversation's channel briefly, and forgets it on a new turn", async () => {
    const conversation = vi.fn(async () => conv({ origin: "web", user_id: "member" }));
    const svc = service(store({ conversation }));
    await svc.session("webchat:c1");
    await svc.session("webchat:c1");
    expect(conversation).toHaveBeenCalledTimes(1);
    svc.forgetConversation("c1");
    await svc.session("webchat:c1");
    expect(conversation).toHaveBeenCalledTimes(2);
  });
});

describe("env parsing", () => {
  it("parseEnvOptIns splits channel-scoped and bare names", () => {
    const m = parseEnvOptIns("exec public:write, PHONE:start_task");
    expect([...m.get("*")!]).toEqual(["exec"]);
    expect([...m.get("public")!]).toEqual(["write"]);
    expect([...m.get("phone")!]).toEqual(["start_task"]);
  });

  it("directServerNames reads OPENCLAW_MCP_SERVERS keys, never the platform one", () => {
    expect(directServerNames(JSON.stringify({ odoo: {}, knoxville_platform: {} }))).toEqual(["odoo"]);
    expect(directServerNames("nope")).toEqual([]);
    expect(directServerNames(undefined)).toEqual([]);
  });
});

describe("child environments", () => {
  it("never get the policy's settings (declared in env.ts, so withheld)", () => {
    for (const k of ["AGENT_SESSION_TOOL_POLICY", "AGENT_UNTRUSTED_SESSION_TOOLS", "AGENT_PLATFORM_MCP_FORWARD"]) {
      expect(isWithheldFromChildren(k), k).toBe(true);
    }
  });
});
