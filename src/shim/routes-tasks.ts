import type { IncomingMessage, ServerResponse } from "node:http";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { HttpError, type Principal } from "./auth.js";
import { detectDelegatedTurn } from "./delegated-credentials.js";
import type { TaskRunner, TaskSpec } from "./task-runner.js";
import type { MessagingDB } from "./supabase-db.js";
import { readJsonBody, sendJson } from "./util.js";

/**
 * The vessel's long-running task surface (console migration 0047).
 *
 *   POST /api/v1/tasks              → accept a task, 202 immediately
 *   POST /api/v1/tasks/:id/cancel   → ask a running task to stop
 *   GET  /api/v1/tasks              → what this vessel is working on
 *
 * The contract that matters is the 202: this endpoint MUST NOT do the work
 * inline. It validates, hands the task to the runner, and returns. Everything
 * after that flows back to the platform over the task callback API, which is
 * what lets a task outlive every timeout between here and the caller.
 *
 * Auth is the same bearer gate as the messaging routes (a platform-minted user
 * JWT, or an A2A agent token on a delegated call), so a task start is
 * authorized exactly like the synchronous turn it replaces.
 */

interface TaskStartBody {
  task_id?: unknown;
  instructions?: unknown;
  title?: unknown;
  conversation_id?: unknown;
  callback_url?: unknown;
  callback_token?: unknown;
  deadline_at?: unknown;
  delegated?: unknown;
  shares_credentials?: unknown;
}

export interface TasksDeps {
  env: AgentEnv;
  db: MessagingDB;
  runner: TaskRunner;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function handleTaskStart(
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  deps: TasksDeps,
): Promise<void> {
  const body = (await readJsonBody<TaskStartBody>(req)) ?? {};

  const taskId = str(body.task_id);
  const instructions = str(body.instructions);
  const callbackUrl = str(body.callback_url);
  const callbackToken = str(body.callback_token);
  if (!taskId) throw new HttpError(400, "task_id required");
  if (!instructions) throw new HttpError(400, "instructions required");
  if (!callbackUrl) throw new HttpError(400, "callback_url required");
  if (!callbackToken) throw new HttpError(400, "callback_token required");

  const conversationId = str(body.conversation_id);

  // Whether this task's turns are delegated decides which lane it runs in (see
  // TaskRunner), so we do not take the platform's word for it alone: the
  // request must ALSO look like a delegated call under the same two-signal test
  // the message path uses — a verified agent principal plus the platform's
  // caller-kind header. A spoofed body flag can therefore only ever downgrade a
  // task into the ordinary lane, never smuggle one into the credential lane.
  const detected = detectDelegatedTurn(
    req.headers,
    principal.kind,
    conversationId ?? "",
  );
  const delegated = body.delegated === true && detected.delegated;
  if (body.delegated === true && !delegated) {
    log.warn("task start claimed delegation the request does not support", {
      task_id: taskId,
      principal_kind: principal.kind,
    });
  }

  // A delegated task without a conversation has no credential scope to inherit
  // (the platform's broker authorizes off the conversation), so it would run
  // with no secrets and fail confusingly deep inside a skill. Reject it here,
  // where the reason is legible.
  if (delegated && !conversationId) {
    throw new HttpError(
      400,
      "a delegated task requires conversation_id (it is the credential scope)",
    );
  }

  if (conversationId) {
    // Same authorization the message path applies — a task must not be able to
    // reach a conversation its caller could not message.
    await authorizeTaskConversation(conversationId, principal, deps);
  }

  const spec: TaskSpec = {
    taskId,
    instructions,
    title: str(body.title),
    conversationId,
    callbackUrl,
    callbackToken,
    deadlineAt: str(body.deadline_at),
    delegated,
    // Only meaningful in AGENT_DELEGATED_TASK_MODE=serial, where it keeps a
    // delegation that shares nothing out of the serialized lane. Default to
    // "assume it might" when the platform doesn't say, so an older console
    // never accidentally un-serializes a task that does carry secrets.
    sharesCredentials: delegated && body.shares_credentials !== false,
  };

  if (!deps.runner.accept(spec)) {
    throw new HttpError(
      429,
      `task queue is full (${deps.env.AGENT_MAX_QUEUED_TASKS}); retry later`,
    );
  }

  log.info("task started", {
    task_id: taskId,
    delegated,
    conversation_id: conversationId,
    active: deps.runner.activeCount,
  });

  // 202 = "accepted, not done". The platform treats anything else as a failed
  // start, so this status is part of the contract, not a detail.
  sendJson(res, 202, { ok: true, task_id: taskId, accepted: true });
}

export async function handleTaskCancel(
  taskId: string,
  _principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  deps: TasksDeps,
): Promise<void> {
  await readJsonBody<Record<string, unknown>>(req).catch(() => null);
  const cancelled = deps.runner.cancel(taskId);
  // Not finding the task is not an error: the platform's flag is authoritative
  // and this poke is only about reaction time. A task that already finished, or
  // that lives on another replica, is simply nothing to do here.
  sendJson(res, 200, { ok: true, task_id: taskId, cancelling: cancelled });
}

export function handleTaskList(res: ServerResponse, deps: TasksDeps): void {
  sendJson(res, 200, {
    ok: true,
    active: deps.runner.activeCount,
    queued: deps.runner.queuedCount,
    max_concurrent: deps.env.AGENT_MAX_CONCURRENT_TASKS,
    tasks: deps.runner.snapshot(),
  });
}

/**
 * Authorize a task against its conversation.
 *
 * Mirrors `authorizeConversation` in routes-messages: the conversation must
 * exist, belong to this agent, and — for a cross-org agent principal — carry the
 * drive-thru binding that permits the call. Kept as its own function because a
 * task start has no message body to validate and no SSE stream to fail into.
 */
async function authorizeTaskConversation(
  conversationId: string,
  principal: Principal,
  deps: TasksDeps,
): Promise<void> {
  const conversation = await deps.db.getConversation(conversationId);
  if (!conversation) throw new HttpError(404, "conversation not found");
  if (conversation.agent_uid !== deps.env.AGENT_UID) {
    throw new HttpError(403, "conversation belongs to another agent");
  }
  if (conversation.archived_at) throw new HttpError(409, "conversation archived");

  if (principal.kind === "agent") {
    const sameOrg = principal.orgId === deps.env.AGENT_ORG;
    if (!sameOrg && !conversation.drive_through_connection_id) {
      throw new HttpError(
        403,
        "cross-org task requires a drive-thru connection on the conversation",
      );
    }
    return;
  }

  const inOrg = await deps.db.userInOrg(principal.userId, deps.env.AGENT_ORG);
  // An anonymous/MCP conversation has no owning user; knowledge of its id is
  // the capability, matching the platform's own rule.
  if (!inOrg && conversation.user_id !== null && conversation.user_id !== principal.userId) {
    throw new HttpError(403, "not authorized for this conversation");
  }
}
