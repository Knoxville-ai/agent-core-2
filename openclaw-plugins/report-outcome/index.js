import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import {
  buildOutcomeParams,
  conversationIdFromSessionKey,
  isReportOutcomeTool,
} from "./outcome.js";

/**
 * Knox report-outcome injector — the OpenClaw half of per-session outcome
 * tracking (knoxville-ai-console migration 0039).
 *
 * The agent closes its session as its final act by calling the platform
 * `report_outcome` MCP tool with a status + 1-2 sentence summary (see the
 * constitution). That tool REQUIRES a `conversation_id`, but the model does not
 * have it and must not type it — the runtime supplies it. This plugin runs on
 * `before_tool_call`: for the `report_outcome` tool it derives the conversation
 * id from `ctx.sessionKey` (which the shim already set to `webchat:<conv>` /
 * `a2a:<conv>`) and stamps it onto the call's params, so the model reports on the
 * exact session it is serving without ever seeing the id.
 *
 * Boundaries this plugin keeps:
 *   - It rewrites tool *execution* params only; the assistant message the model
 *     produced (persisted to the transcript) is untouched.
 *   - `conversation_id` is the session's own id, not a secret, so logging it is
 *     fine and useful for tracing an outcome end-to-end.
 *   - Fail-open: on a session key it can't read, it leaves the call unchanged
 *     (the platform rejects a blank conversation_id and the console's idle-sweep
 *     cron closes the session as `unknown` instead).
 *   - Per-session correctness: the id comes from `ctx.sessionKey`, so a delegated
 *     (A2A) turn reports on the delegated conversation it was given, and a webchat
 *     turn reports on its own — exactly as the contract requires.
 */

export default definePluginEntry({
  id: "knox-report-outcome",
  name: "Knox Report Outcome",
  description:
    "Stamp the platform conversation id onto the agent's report_outcome MCP call so the model never has to know or type it.",
  register(api) {
    api.on(
      "before_tool_call",
      async (event, ctx) => {
        if (!isReportOutcomeTool(event?.toolName)) return;
        const sessionKey = ctx?.sessionKey;
        const conversationId = conversationIdFromSessionKey(sessionKey);
        if (!conversationId) {
          // No usable session key → let the call through unchanged. Fail-open:
          // the platform rejects a missing/blank conversation_id, and the
          // console idle-sweep backstops the session close.
          console.error(
            `[knox-report-outcome] report_outcome with no derivable conversation id ` +
              `(session=${sessionKey ?? "undefined"})`,
          );
          return;
        }
        const params = buildOutcomeParams(event?.params ?? {}, conversationId);
        if (!params) return; // already correct → no change to the tool call
        // conversation_id is the session's own id (not a secret) — safe to log.
        console.error(
          `[knox-report-outcome] stamped conversation_id=${conversationId} onto ` +
            `report_outcome (session=${sessionKey})`,
        );
        return { params };
      },
      { priority: 40 },
    );
  },
});
