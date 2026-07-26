// Pure, dependency-free logic for the report-outcome plugin, split out from
// index.js so it can be unit-tested without loading the OpenClaw SDK.
//
// The platform `report_outcome` MCP tool closes the current session with a
// self-reported status + summary (see knoxville-ai-console CONTRACT.md, migration
// 0039). `conversation_id` is REQUIRED by that tool, but the MODEL does not know
// it — the runtime does. This module derives the conversation id from the
// OpenClaw session key and stamps it onto the tool call so the model never has to
// (and never gets to) type it.

/**
 * The platform's session-closing tool. OpenClaw may surface an MCP server's tool
 * either bare (`report_outcome`) or namespaced under the server it came from
 * (e.g. `knoxville_platform.report_outcome`, `...:report_outcome`,
 * `...__report_outcome`). Match the bare name and those common prefixings; the
 * value is our own tool name, so a false positive against an unrelated tool is
 * not a realistic concern.
 */
const REPORT_OUTCOME_SUFFIX = /(^|[.:/]|__)report_outcome$/;

/** True when `toolName` is the platform `report_outcome` tool (bare or prefixed). */
export function isReportOutcomeTool(toolName) {
  return typeof toolName === "string" && REPORT_OUTCOME_SUFFIX.test(toolName);
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
  const sep = sessionKey.indexOf(":");
  if (sep === -1) return null;
  const id = sessionKey.slice(sep + 1).trim();
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
export function buildOutcomeParams(params, conversationId) {
  if (typeof conversationId !== "string" || conversationId.length === 0) return null;
  const base =
    params && typeof params === "object" && !Array.isArray(params) ? params : {};
  if (base.conversation_id === conversationId) return null;
  return { ...base, conversation_id: conversationId };
}
