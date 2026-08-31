// Pure, dependency-free logic for the conversation-id injector plugin, split out
// from index.js so it can be unit-tested without loading the OpenClaw SDK.
//
// Two platform MCP tools need the id of the conversation the agent is currently
// serving, and in BOTH cases the model has no way to know it — the runtime does:
//
//   report_outcome  closes the session with a self-reported status + summary
//                   (console CONTRACT.md, migration 0039).
//   start_task      hands long-running work to another agent (migration 0047).
//                   Its `conversation_id` is the CALLER's session — where the
//                   task card renders and where the result is delivered when the
//                   work lands. Omit it and the task still runs, but silently
//                   becomes fire-and-forget: no card, and nobody is ever woken
//                   with the answer. That is exactly what happened before this
//                   plugin covered it.
//
// This module derives the conversation id from the OpenClaw session key and
// stamps it onto the tool call so the model never has to (and never gets to)
// type it.

/**
 * The platform's session-closing tool. OpenClaw may surface an MCP server's tool
 * either bare (`report_outcome`) or namespaced under the server it came from
 * (e.g. `knoxville_platform.report_outcome`, `...:report_outcome`,
 * `...__report_outcome`). Match the bare name and those common prefixings; the
 * value is our own tool name, so a false positive against an unrelated tool is
 * not a realistic concern.
 */
const REPORT_OUTCOME_SUFFIX = /(^|[.:/]|__)report_outcome$/;

/** The platform's long-running-task starter. Same namespacing rules. */
const START_TASK_SUFFIX = /(^|[.:/]|__)start_task$/;

/** The platform's human-escalation tool (console migration 0048). Its
 *  `conversation_id` is the session being parked — the one the human's answer is
 *  delivered back into — which is exactly the session the agent is serving. */
const ESCALATE_TO_HUMAN_SUFFIX = /(^|[.:/]|__)escalate_to_human$/;

/** The platform's team-email tool (console migration 0059). Its `conversation_id`
 *  is optional and purely for the audit row — it records which session an
 *  outbound email was sent from. Nothing breaks when it is absent, so this one
 *  is a nicety rather than load-bearing. */
const SEND_EMAIL_SUFFIX = /(^|[.:/]|__)send_email$/;

/** The platform's human-approved OUTBOUND-customer-email tool (console migration
 *  0068). Like escalate_to_human it PARKS the session it is called from until a
 *  human approves the draft, so its `conversation_id` (or `task_id` in a task
 *  session) is the session being parked — the one the agent is serving. The
 *  model cannot know it and the tool REJECTS the call without it, so here this is
 *  load-bearing, not a nicety. Distinct from send_email: "send_customer_email"
 *  does not contain the "send_email" substring, so the two suffixes never
 *  collide. */
const SEND_CUSTOMER_EMAIL_SUFFIX = /(^|[.:/]|__)send_customer_email$/;

/**
 * Every platform tool that needs the id of the session the agent is serving,
 * and the PARAM each one wants it under.
 *
 * The names differ on purpose. `report_outcome` and `start_task` take
 * `conversation_id` — the session being closed, or the session the task's
 * result comes back to. The two conversation-openers already RETURN a
 * `conversation_id` (the new one), so taking one as input would be ambiguous;
 * they use `caller_conversation_id`, meaning "the session I am calling from",
 * which the platform uses to thread the delegation into one session tree and to
 * compute the real call depth.
 */
const CONVERSATION_ID_TOOLS = [
  { suffix: REPORT_OUTCOME_SUFFIX, param: "conversation_id" },
  { suffix: START_TASK_SUFFIX, param: "conversation_id" },
  { suffix: ESCALATE_TO_HUMAN_SUFFIX, param: "conversation_id" },
  { suffix: SEND_EMAIL_SUFFIX, param: "conversation_id" },
  { suffix: SEND_CUSTOMER_EMAIL_SUFFIX, param: "conversation_id" },
  {
    suffix: /(^|[.:/]|__)start_conversation$/,
    param: "caller_conversation_id",
  },
  {
    suffix: /(^|[.:/]|__)start_agent_conversation$/,
    param: "caller_conversation_id",
  },
];

/** True when `toolName` is the platform `report_outcome` tool (bare or prefixed). */
export function isReportOutcomeTool(toolName) {
  return typeof toolName === "string" && REPORT_OUTCOME_SUFFIX.test(toolName);
}

/** True when `toolName` is the platform `start_task` tool (bare or prefixed). */
export function isStartTaskTool(toolName) {
  return typeof toolName === "string" && START_TASK_SUFFIX.test(toolName);
}

/** True when `toolName` is the platform `escalate_to_human` tool. */
export function isEscalateToHumanTool(toolName) {
  return typeof toolName === "string" && ESCALATE_TO_HUMAN_SUFFIX.test(toolName);
}

/** True when `toolName` is the platform `send_customer_email` tool. Like
 *  escalate_to_human it parks the session it is called from, so a TASK session
 *  stamps `task_id` and a webchat/a2a session stamps `conversation_id`. */
export function isSendCustomerEmailTool(toolName) {
  return typeof toolName === "string" && SEND_CUSTOMER_EMAIL_SUFFIX.test(toolName);
}

/**
 * The param name this tool wants the caller's conversation id under, or null
 * when the tool does not take one.
 */
export function conversationIdParamFor(toolName) {
  if (typeof toolName !== "string") return null;
  for (const entry of CONVERSATION_ID_TOOLS) {
    if (entry.suffix.test(toolName)) return entry.param;
  }
  return null;
}

/** True for any tool this plugin stamps a conversation id onto. */
export function needsConversationId(toolName) {
  return conversationIdParamFor(toolName) !== null;
}

/**
 * Derive the platform conversation id from an OpenClaw session key. The shim keys
 * sessions as `webchat:<conversationId>` or `a2a:<conversationId>` (see
 * src/shim/routes-messages.ts); the conversation id itself is a UUID with no
 * colon, so the id is everything after the first `:`. Returns null for a key we
 * cannot read (missing, blank, or no separator) so the caller leaves the call
 * unchanged rather than injecting a bogus id.
 */
export function conversationIdFromSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") return null;
  // A `task:<taskId>` session is a long-running task executor, not a session
  // that can be closed (console migration 0047). Everything after the colon
  // there is a TASK id, and stamping it as a conversation id would send the
  // platform a close for a conversation that does not exist. A task reports its
  // own terminal state through the task callback API instead, and the
  // conversation it ran in is closed by the normal idle sweep.
  if (sessionKey.startsWith("task:")) return null;
  const sep = sessionKey.indexOf(":");
  if (sep === -1) return null;
  const id = sessionKey.slice(sep + 1).trim();
  return id.length > 0 ? id : null;
}

/**
 * The task id for a `task:<taskId>` session key, else null. escalate_to_human
 * (0048) is the one tool a task executor may call that parks the SESSION — and a
 * task's session is the task itself, not a conversation. The platform resolves
 * the work conversation from the task id, so here we hand it the task id rather
 * than a conversation id the plugin has no way to know.
 */
export function taskIdFromSessionKey(sessionKey) {
  if (typeof sessionKey !== "string" || !sessionKey.startsWith("task:")) return null;
  const id = sessionKey.slice("task:".length).trim();
  return id.length > 0 ? id : null;
}

/**
 * Stamp the runtime-derived `conversation_id` onto a COPY of the report_outcome
 * tool params and return the new params object, or `null` when there is nothing
 * to change (so the caller returns void = "no change" to OpenClaw).
 *
 * Rules:
 *   - The runtime is AUTHORITATIVE for `conversation_id`: the model cannot know
 *     it and is told not to set it, so we OVERRIDE any value the model supplied.
 *     (This is the opposite of the delegated-credentials plugin's "explicit
 *     wins" — a hallucinated id must never reach the platform, which would reject
 *     it as "not your session" anyway.)
 *   - No id to inject → null.
 *   - Already exactly correct → null (no-op).
 *   - The input params object is not mutated.
 */
export function buildOutcomeParams(params, conversationId, paramName = "conversation_id") {
  if (typeof conversationId !== "string" || conversationId.length === 0) return null;
  const base =
    params && typeof params === "object" && !Array.isArray(params) ? params : {};
  if (base[paramName] === conversationId) return null;
  return { ...base, [paramName]: conversationId };
}

/**
 * Stamp the runtime-derived `conversation_id` onto a COPY of the start_task
 * params. Identical rules to buildOutcomeParams — the runtime is authoritative
 * and overrides anything the model supplied, because the model cannot know this
 * id and a guessed one would silently misroute the task's result to another
 * session (or to none at all).
 *
 * Deliberately shares the implementation: the two tools want the same value
 * derived the same way, and letting them drift is how one of them ends up
 * unstamped.
 */
export const buildStartTaskParams = buildOutcomeParams;
