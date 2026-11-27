import { describe, expect, it } from "vitest";

import type { AgentEnv } from "../env.js";
import { HttpError, type Principal, type TaskBinding } from "./auth.js";
import { classifyRoute, enforceBearerPolicy, type ShimRoute } from "./bearer-policy.js";
import type { MessagingDB } from "./supabase-db.js";

const ORG = "acme";
const AGENT = "0123456789abcdef";

function env(over: Partial<AgentEnv> = {}): AgentEnv {
  return { AGENT_ORG: ORG, AGENT_UID: AGENT, ...over } as AgentEnv;
}
const strict = () => env({ AGENT_BEARER_POLICY: "platform-only" });

function db(members: string[] = []): Pick<MessagingDB, "userInOrg"> {
  return {
    async userInOrg(userId: string, orgId: string) {
      return orgId === ORG && members.includes(userId);
    },
  };
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
}

const session = (userId: string): Principal => ({
  kind: "user",
  userId,
  email: null,
  role: "authenticated",
  source: "supabase-session",
});
const platformUser = (userId: string, task?: TaskBinding): Principal => ({
  kind: "user",
  userId,
  email: null,
  role: "authenticated",
  source: "platform",
  ...(task ? { task } : {}),
});
const agentFrom = (orgId: string): Principal => ({
  kind: "agent",
  agentUid: "caller00000000aa",
  targetUid: AGENT,
  orgId,
  source: "platform",
});
const service: Principal = {
  kind: "service",
  subject: "task-9",
  conversationId: "conv-1",
  origin: "task-callback",
  source: "platform",
};

const messages = (conversationId: string): ShimRoute => ({
  kind: "conversation",
  conversationId,
  action: "messages",
});
const ROUTES: ShimRoute[] = [
  messages("conv-1"),
  { kind: "conversation", conversationId: "conv-1", action: "interrupt" },
  { kind: "task-start" },
  { kind: "task-cancel", taskId: "task-1" },
  { kind: "task-list" },
  { kind: "oauth" },
];

describe("classifyRoute", () => {
  it("names the bearer-gated routes", () => {
    expect(classifyRoute("/api/v1/conversations/c1/messages", "POST")).toEqual(messages("c1"));
    expect(classifyRoute("/api/v1/conversations/c1/interrupt", "POST")).toMatchObject({
      action: "interrupt",
    });
    expect(classifyRoute("/api/v1/tasks", "POST")).toEqual({ kind: "task-start" });
    expect(classifyRoute("/api/v1/tasks", "GET")).toEqual({ kind: "task-list" });
    expect(classifyRoute("/api/v1/tasks/t1/cancel", "POST")).toEqual({
      kind: "task-cancel",
      taskId: "t1",
    });
    expect(classifyRoute("/api/v1/auth/oauth/start", "POST")).toEqual({ kind: "oauth" });
    expect(classifyRoute("/api/v1/agents/x/files", "GET")).toEqual({ kind: "other" });
  });
});

describe("Supabase session tokens (older consoles)", () => {
  it("are refused on every route for someone outside this agent's org", async () => {
    for (const route of ROUTES) {
      expect(await status(enforceBearerPolicy(session("outsider"), route, env(), db()))).toBe(403);
    }
  });

  it("pass for a member of this agent's org", async () => {
    for (const route of ROUTES) {
      expect(
        await status(enforceBearerPolicy(session("member"), route, env(), db(["member"]))),
      ).toBe(200);
    }
  });
});

describe("service tokens", () => {
  it("reach only the messages route of their own conversation", async () => {
    expect(await status(enforceBearerPolicy(service, messages("conv-1"), env(), db()))).toBe(200);
    expect(await status(enforceBearerPolicy(service, messages("conv-2"), env(), db()))).toBe(403);
    for (const route of ROUTES.slice(1)) {
      expect(await status(enforceBearerPolicy(service, route, env(), db()))).toBe(403);
    }
  });
});

describe("task-bound tokens", () => {
  const bound = platformUser("user-1", {
    taskId: "task-1",
    orgId: ORG,
    callbackUrl: "https://console.example/api/tasks/task-1",
  });

  it("reach their own task's start and cancel", async () => {
    expect(await status(enforceBearerPolicy(bound, { kind: "task-start" }, strict(), db()))).toBe(200);
    expect(
      await status(
        enforceBearerPolicy(bound, { kind: "task-cancel", taskId: "task-1" }, strict(), db()),
      ),
    ).toBe(200);
  });

  it("are refused for a different task", async () => {
    expect(
      await status(
        enforceBearerPolicy(bound, { kind: "task-cancel", taskId: "task-2" }, strict(), db()),
      ),
    ).toBe(403);
  });

  it("are refused off the task routes", async () => {
    for (const route of [messages("conv-1"), { kind: "task-list" } as ShimRoute, { kind: "oauth" } as ShimRoute]) {
      expect(await status(enforceBearerPolicy(bound, route, env(), db(["user-1"])))).toBe(403);
    }
  });

  it("are refused when the task belongs to another org", async () => {
    const otherOrg = platformUser("user-1", {
      taskId: "task-1",
      orgId: "globex",
      callbackUrl: "https://console.example/api/tasks/task-1",
    });
    expect(await status(enforceBearerPolicy(otherOrg, { kind: "task-start" }, env(), db()))).toBe(403);
  });
});

describe("unbound tokens on task routes", () => {
  it("are accepted during the transition (legacy-org-check)", async () => {
    expect(
      await status(enforceBearerPolicy(platformUser("task-1"), { kind: "task-start" }, env(), db())),
    ).toBe(200);
  });

  it("are refused under platform-only", async () => {
    expect(
      await status(enforceBearerPolicy(platformUser("task-1"), { kind: "task-start" }, strict(), db())),
    ).toBe(403);
    expect(
      await status(
        enforceBearerPolicy(agentFrom(ORG), { kind: "task-cancel", taskId: "t" }, strict(), db()),
      ),
    ).toBe(403);
  });
});

describe("task list", () => {
  it("is for this org's members and agents only", async () => {
    const list: ShimRoute = { kind: "task-list" };
    expect(await status(enforceBearerPolicy(agentFrom(ORG), list, env(), db()))).toBe(200);
    expect(await status(enforceBearerPolicy(agentFrom("globex"), list, env(), db()))).toBe(403);
    expect(await status(enforceBearerPolicy(platformUser("u"), list, env(), db(["u"])))).toBe(200);
    expect(await status(enforceBearerPolicy(platformUser("conv-1"), list, env(), db()))).toBe(403);
  });
});
