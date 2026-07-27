// Pure, dependency-free logic for the task-progress plugin, split out from
// index.js so it can be unit-tested without loading the OpenClaw SDK.
//
// The platform `report_task_progress` MCP tool narrates a long-running task on
// the card in the caller's chat thread (see knoxville-ai-console migration
// 0047). `task_id` is REQUIRED by that tool, but the MODEL does not know it —
// the runtime does, because it keyed the session `task:<taskId>` when it started
// the executor. This module derives the id from the session key and stamps it
// onto the tool call, exactly as the report-outcome plugin does for
// conversation_id.

/**
 * The platform's progress tool. OpenClaw may surface an MCP server's tool either
 * bare (`report_task_progress`) or namespaced under the server it came from
 * (e.g. `knoxville_platform.report_task_progress`, `...:report_task_progress`,
 * `...__report_task_progress`). Match the bare name and those common prefixings.
 */
const REPORT_PROGRESS_SUFFIX = /(^|[.:/]|__)report_task_progress$/;

/** True when `toolName` is the platform `report_task_progress` tool. */
export function isReportProgressTool(toolName) {
  return typeof toolName === "string" && REPORT_PROGRESS_SUFFIX.test(toolName);
}

/**
 * Derive the task id from an OpenClaw session key.
 *
 * The shim keys a task executor's session `task:<taskId>` (see
 * src/shim/task-runner.ts), which is what distinguishes it from the
 * `webchat:<conversationId>` / `a2a:<conversationId>` keys an ordinary turn
 * uses. Returns null for anything that is not a task session, so a model that
 * calls the progress tool from a normal chat leaves the call unchanged and the
 * platform rejects it — rather than having a conversation id silently stamped in
 * as if it were a task.
 */
export function taskIdFromSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") return null;
  if (!sessionKey.startsWith("task:")) return null;
  const id = sessionKey.slice("task:".length).trim();
  return id.length > 0 ? id : null;
}

/**
 * Stamp the runtime-derived `task_id` onto a COPY of the tool params and return
 * the new params object, or `null` when there is nothing to change (so the
 * caller returns void = "no change" to OpenClaw).
 *
 * The runtime is AUTHORITATIVE: the model cannot know the task id and is told
 * not to set it, so any value it supplied is overridden. A hallucinated id would
 * be rejected by the platform anyway ("you are not the agent executing this
 * task"), but overriding keeps the failure impossible rather than merely
 * unlikely.
 */
export function buildProgressParams(params, taskId) {
  if (typeof taskId !== "string" || taskId.length === 0) return null;
  const base =
    params && typeof params === "object" && !Array.isArray(params) ? params : {};
  if (base.task_id === taskId) return null;
  return { ...base, task_id: taskId };
}
