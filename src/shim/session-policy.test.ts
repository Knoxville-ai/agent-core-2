import { describe, expect, it } from "vitest";

import {
  classifyConversation,
  classifyEmail,
  classifyTool,
  decideTool,
  parseSessionKey,
  untrustedReadAllowed,
  type ConversationFacts,
  type SessionChannel,
} from "./session-policy.js";

const WS = "/home/agent/.openclaw/workspace";
const SERVERS = ["odoo_production", "quickbooks"];

function facts(over: Partial<ConversationFacts>): ConversationFacts {
  return {
    origin: null,
    userId: null,
    userIsMember: false,
    callerAgentUid: null,
    callerAgentOrgId: null,
    agentOrgId: "acme",
    delegationConnectionId: null,
    driveThroughConnectionId: null,
    ...over,
  };
}

function decide(channel: SessionChannel, toolName: string, params: unknown = {}, optIns: string[] = []) {
  return decideTool({ channel, toolName, params, servers: SERVERS, optIns: new Set(optIns), workspaceDir: WS });
}

describe("parseSessionKey", () => {
  it("names the shim's and the voice plugin's sessions, however prefixed", () => {
    expect(parseSessionKey("webchat:c1")).toEqual({ kind: "webchat", id: "c1" });
    expect(parseSessionKey("agent:main:a2a:c2")).toEqual({ kind: "a2a", id: "c2" });
    expect(parseSessionKey("task:t1")).toEqual({ kind: "task", id: "t1" });
    expect(parseSessionKey("agent:main:voice:19015550100")).toEqual({ kind: "voice", id: "voice:19015550100" });
    expect(parseSessionKey("agent:main:main")).toEqual({ kind: "other", id: null });
    expect(parseSessionKey(undefined)).toEqual({ kind: "other", id: null });
  });
});

describe("classifyConversation (mirrors the console)", () => {
  it("public: listing chats with nobody from the org, SMS, unconnected agents from another org", () => {
    expect(classifyConversation(facts({ origin: "web" }))).toBe("public");
    expect(classifyConversation(facts({ origin: "mcp" }))).toBe("public");
    expect(classifyConversation(facts({ origin: "web", userId: "u", userIsMember: false }))).toBe("public");
    expect(classifyConversation(facts({ origin: "sms", userId: "u", userIsMember: true }))).toBe("public");
    expect(classifyConversation(facts({ callerAgentUid: "a", callerAgentOrgId: "other" }))).toBe("public");
    expect(classifyConversation(facts({ origin: "mobile", userId: "u", userIsMember: false }))).toBe("public");
  });

  it("trusted: members, routines, same-org or connected delegation", () => {
    expect(classifyConversation(facts({ origin: "web", userId: "u", userIsMember: true }))).toBe("trusted");
    expect(classifyConversation(facts({ origin: "routine" }))).toBe("trusted");
    expect(classifyConversation(facts({ callerAgentUid: "a", callerAgentOrgId: "acme" }))).toBe("trusted");
    expect(
      classifyConversation(facts({ callerAgentUid: "a", callerAgentOrgId: "other", driveThroughConnectionId: "d" })),
    ).toBe("trusted");
  });

  it("email: only a sender the address vouches for, or an assistant's own owner", () => {
    expect(classifyEmail({ fromEmail: "x@y.z", inboundPolicy: "open", personalAssistant: false, ownerAddresses: [] })).toBe("email");
    expect(classifyEmail({ fromEmail: null, inboundPolicy: "members", personalAssistant: false, ownerAddresses: [] })).toBe("email");
    expect(classifyEmail({ fromEmail: "x@y.z", inboundPolicy: "members", personalAssistant: false, ownerAddresses: [] })).toBe("trusted");
    expect(classifyEmail({ fromEmail: "Me@Y.z", inboundPolicy: "open", personalAssistant: true, ownerAddresses: ["me@y.z"] })).toBe("trusted");
    expect(classifyEmail({ fromEmail: "guest@y.z", inboundPolicy: "owner", personalAssistant: true, ownerAddresses: ["me@y.z"] })).toBe("email");
  });
});

describe("classifyTool", () => {
  it("tells platform, direct connector and built-in tools apart", () => {
    expect(classifyTool("knoxville_platform__list_my_tasks", SERVERS)).toEqual({ kind: "platform", tool: "list_my_tasks" });
    expect(classifyTool("odoo_production__sales_confirm_order", SERVERS)).toEqual({
      kind: "connector",
      server: "odoo_production",
      tool: "sales_confirm_order",
    });
    expect(classifyTool("exec", SERVERS)).toEqual({ kind: "builtin", tool: "exec" });
  });
});

describe("decideTool", () => {
  it("a trusted session keeps every tool", () => {
    for (const t of ["exec", "write", "odoo_production__sales_confirm_order", "knoxville_platform__recall", "sessions_spawn"]) {
      expect(decide("trusted", t)).toEqual({ allow: true });
    }
  });

  it("an untrusted session can't run commands, write files, reach connectors or other sessions", () => {
    for (const channel of ["public", "email", "phone"] as const) {
      for (const t of [
        "exec",
        "process",
        "write",
        "edit",
        "apply_patch",
        "sessions_spawn",
        "sessions_history",
        "subagents",
        "memory_search",
        "odoo_production__sales_confirm_order",
        "some_unknown_tool",
      ]) {
        const d = decide(channel, t);
        expect(d.allow, `${channel} ${t}`).toBe(false);
      }
    }
  });

  it("an untrusted session keeps only the console's minimal set of platform tools", () => {
    for (const t of ["list_my_tasks", "recall", "remember", "start_task", "send_message", "tickets_search"]) {
      expect(decide("public", `knoxville_platform__${t}`).allow, t).toBe(false);
    }
    for (const t of ["escalate_to_human", "read_knowledge", "report_outcome", "publish_artifact"]) {
      expect(decide("public", `knoxville_platform__${t}`).allow, t).toBe(true);
    }
    expect(decide("public", "knoxville_platform__send_customer_email").allow).toBe(false);
    expect(decide("email", "knoxville_platform__send_customer_email").allow).toBe(true);
  });

  it("a phone call before the PIN keeps what the call is waiting on, and the PIN check", () => {
    expect(decide("phone", "knoxville_platform__list_call_escalations").allow).toBe(true);
    expect(decide("phone", "knoxville_platform__answer_call_escalation").allow).toBe(true);
    expect(decide("phone", "verify_caller_pin").allow).toBe(true);
    const startTask = decide("phone", "knoxville_platform__start_task");
    expect(startTask.allow).toBe(false);
    expect(!startTask.allow && startTask.reason).toContain("verify_caller_pin");
  });

  it("read-only built-ins stay, and reads stay inside the workspace and out of the agent's memory", () => {
    expect(decide("public", "web_search").allow).toBe(true);
    expect(decide("public", "read", { path: "skills/brand/SKILL.md" }).allow).toBe(true);
    expect(decide("public", "read", { path: `${WS}/knowledge/menu.md` }).allow).toBe(true);
    expect(decide("public", "read", { path: "playbook.md" }).allow).toBe(false);
    expect(decide("public", "read", { path: "notes/customers.md" }).allow).toBe(false);
    expect(decide("public", "read", { path: "../openclaw.json" }).allow).toBe(false);
    expect(decide("public", "read", { path: "/etc/passwd" }).allow).toBe(false);
    expect(decide("public", "read", {}).allow).toBe(false);
  });

  it("an org's opt-in for the channel allows a tool there", () => {
    expect(decide("public", "exec", {}, ["exec"]).allow).toBe(true);
    expect(decide("public", "knoxville_platform__list_my_tasks", {}, ["list_my_tasks"]).allow).toBe(true);
    expect(decide("public", "odoo_production__sales_get_order", {}, ["odoo_production__sales_get_order"]).allow).toBe(true);
  });

  it("the refusal says why, for the agent", () => {
    const d = decide("public", "exec");
    expect(!d.allow && d.reason).toMatch(/outside your organization/);
    const e = decide("email", "exec");
    expect(!e.allow && e.reason).toMatch(/email/);
  });
});

describe("untrustedReadAllowed", () => {
  it("resolves relative paths against the workspace", () => {
    expect(untrustedReadAllowed("a/b.txt", WS)).toBe(true);
    expect(untrustedReadAllowed("./a/../../x", WS)).toBe(false);
    expect(untrustedReadAllowed("Notes/x.md", WS)).toBe(false);
    expect(untrustedReadAllowed(".", WS)).toBe(false);
  });
});
