import type { AgentEnv } from "../env.js";
import { HttpError, isPlatformOnly, type Principal } from "./auth.js";
import type { MessagingDB } from "./supabase-db.js";

/**
 * Route-level bearer rules, applied once per request right after verifyBearer
 * (server.ts), before any handler runs. verifyBearer says who the token names;
 * this says which routes that token may reach.
 *
 *  - A Supabase session token (pre-platform consoles only) is honoured for a
 *    member of AGENT_ORG, on every route. Conversation-level checks in the
 *    handlers still apply on top.
 *  - A service token reaches only the messages route of the conversation it
 *    was minted for.
 *  - A task-bound token reaches only its own task's start and cancel routes,
 *    and only when the task belongs to this agent's org. The start handler
 *    also checks the body's task_id and callback_url against the binding.
 *  - Under AGENT_BEARER_POLICY=platform-only, task start and cancel require a
 *    task-bound token.
 *  - Listing tasks is for this org's members and agents.
 */

export type ShimRoute =
  | { kind: "conversation"; conversationId: string; action: "messages" | "interrupt" }
  | { kind: "task-start" }
  | { kind: "task-cancel"; taskId: string }
  | { kind: "task-list" }
  | { kind: "oauth" }
  | { kind: "other" };

/** Which bearer-gated route a request is for. */
export function classifyRoute(path: string, method: string): ShimRoute {
  const conv = /^\/api\/v1\/conversations\/([^/]+)\/(messages|interrupt)$/.exec(path);
  if (conv) {
    return {
      kind: "conversation",
      conversationId: conv[1]!,
      action: conv[2] === "messages" ? "messages" : "interrupt",
    };
  }
  if (path === "/api/v1/tasks") {
    return method === "GET" ? { kind: "task-list" } : { kind: "task-start" };
  }
  const cancel = /^\/api\/v1\/tasks\/([^/]+)\/cancel$/.exec(path);
  if (cancel) return { kind: "task-cancel", taskId: cancel[1]! };
  if (path.startsWith("/api/v1/auth/oauth/")) return { kind: "oauth" };
  return { kind: "other" };
}

export async function enforceBearerPolicy(
  principal: Principal,
  route: ShimRoute,
  env: AgentEnv,
  db: Pick<MessagingDB, "userInOrg">,
): Promise<void> {
  if (principal.kind === "user" && principal.source === "supabase-session") {
    if (!(await db.userInOrg(principal.userId, env.AGENT_ORG))) {
      throw new HttpError(403, "forbidden");
    }
  }

  if (principal.kind === "service") {
    const allowed =
      route.kind === "conversation" &&
      route.action === "messages" &&
      route.conversationId === principal.conversationId;
    if (!allowed) throw new HttpError(403, "token is not valid for this route");
    return;
  }

  if (principal.task) {
    const forThisTask =
      route.kind === "task-start" ||
      (route.kind === "task-cancel" && route.taskId === principal.task.taskId);
    if (!forThisTask) throw new HttpError(403, "token is bound to another task");
    if (principal.task.orgId !== env.AGENT_ORG) {
      throw new HttpError(403, "task belongs to another org");
    }
    return;
  }

  if ((route.kind === "task-start" || route.kind === "task-cancel") && isPlatformOnly(env)) {
    throw new HttpError(403, "task routes require a token bound to the task");
  }

  if (route.kind === "task-list") {
    const allowed =
      principal.kind === "agent"
        ? principal.orgId === env.AGENT_ORG
        : await db.userInOrg(principal.userId, env.AGENT_ORG);
    if (!allowed) throw new HttpError(403, "forbidden");
  }
}
