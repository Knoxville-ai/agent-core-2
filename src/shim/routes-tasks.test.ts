import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import type { AgentEnv } from "../env.js";
import { HttpError, type Principal } from "./auth.js";
import { handleTaskStart, type TasksDeps } from "./routes-tasks.js";
import type { Conversation, MessagingDB } from "./supabase-db.js";
import type { TaskRunner, TaskSpec } from "./task-runner.js";

const ORG = "acme";
const AGENT = "0123456789abcdef";
const CALLBACK = "https://console.example/api/tasks/task-1";

function req(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const r = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (r as { headers: Record<string, string> }).headers = headers;
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

function deps(conversation: Conversation | null = null): TasksDeps & { accepted: TaskSpec[] } {
  const accepted: TaskSpec[] = [];
  return {
    accepted,
    env: { AGENT_ORG: ORG, AGENT_UID: AGENT, AGENT_MAX_QUEUED_TASKS: 10 } as unknown as AgentEnv,
    db: {
      async getConversation() {
        return conversation;
      },
      async userInOrg() {
        return false;
      },
    } as unknown as MessagingDB,
    runner: {
      accept(spec: TaskSpec) {
        accepted.push(spec);
        return true;
      },
      activeCount: 0,
    } as unknown as TaskRunner,
  };
}

const body = (over: Record<string, unknown> = {}) => ({
  task_id: "task-1",
  instructions: "do the thing",
  callback_url: CALLBACK,
  callback_token: "cb-token",
  ...over,
});

function user(task?: { taskId: string; orgId: string; callbackUrl: string }): Principal {
  return {
    kind: "user",
    userId: "user-1",
    email: null,
    role: "authenticated",
    source: "platform",
    ...(task ? { task } : {}),
  };
}
const boundUser = user({ taskId: "task-1", orgId: ORG, callbackUrl: CALLBACK });

async function start(principal: Principal, b: unknown, d = deps()): Promise<number> {
  const r = res();
  try {
    await handleTaskStart(principal, req(b), r.res, d);
    return r.status();
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
}

describe("handleTaskStart with a task-bound token", () => {
  it("accepts the task the token was minted for", async () => {
    const d = deps();
    expect(await start(boundUser, body(), d)).toBe(202);
    expect(d.accepted.map((s) => s.taskId)).toEqual(["task-1"]);
  });

  it("refuses a token minted for a different task", async () => {
    const d = deps();
    expect(await start(boundUser, body({ task_id: "task-2" }), d)).toBe(403);
    expect(d.accepted).toEqual([]);
  });

  it("refuses a callback URL other than the one in the token", async () => {
    const d = deps();
    expect(
      await start(boundUser, body({ callback_url: "https://elsewhere.example/collect" }), d),
    ).toBe(403);
    expect(d.accepted).toEqual([]);
  });

  it("refuses a bound token that names no callback URL", async () => {
    const noCallback = user({ taskId: "task-1", orgId: ORG, callbackUrl: "" });
    expect(await start(noCallback, body())).toBe(403);
  });
});

describe("handleTaskStart with an unbound token (older console)", () => {
  it("still accepts a console-minted user token", async () => {
    expect(await start(user(), body())).toBe(202);
  });

  it("refuses a cross-org agent with no conversation", async () => {
    const crossOrg: Principal = {
      kind: "agent",
      agentUid: "caller00000000aa",
      targetUid: AGENT,
      orgId: "globex",
      source: "platform",
    };
    expect(await start(crossOrg, body())).toBe(403);
  });

  it("refuses a conversation in another org", async () => {
    const conv = {
      id: "conv-1",
      org_id: "globex",
      agent_uid: AGENT,
      user_id: null,
      title: null,
      archived_at: null,
      kind: "user_agent",
    } as Conversation;
    expect(await start(user(), body({ conversation_id: "conv-1" }), deps(conv))).toBe(403);
  });
});

describe("handleTaskStart with a service token", () => {
  it("is refused", async () => {
    const service: Principal = {
      kind: "service",
      subject: "s",
      conversationId: "conv-1",
      origin: "task-callback",
      source: "platform",
    };
    expect(await start(service, body())).toBe(403);
  });
});
