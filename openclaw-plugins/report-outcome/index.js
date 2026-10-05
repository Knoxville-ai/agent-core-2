import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import {
  buildOutcomeParams,
  conversationIdFromSessionKey,
  conversationIdParamFor,
  isArtifactSessionTool,
  isCreateReminderTool,
  isEscalateToHumanTool,
  isLearningLinkTool,
  isSendCustomerEmailTool,
  isStartTaskTool,
  taskIdFromSessionKey,
} from "./outcome.js";
import { inlineArtifactFile, isPublishArtifactTool, workspaceDir } from "./artifact.js";

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
  name: "Knox Conversation Id Injector",
  description:
    "Stamp the platform conversation id onto the agent's report_outcome, start_task, escalate_to_human, send_email, send_customer_email, ask_question, submit_for_review, create_reminder and artifact MCP calls so the model never has to know or type it; attach the file a publish_artifact call names.",
  register(api) {
    api.on(
      "before_tool_call",
      async (event, ctx) => {
        const toolName = event?.toolName;
        const stamped = stampSession(event, ctx);
        if (!isPublishArtifactTool(toolName)) return stamped ? { params: stamped } : undefined;

        // publish_artifact (0138) may name a workspace file instead of carrying
        // the page: swap the path for the file's contents. A bad path blocks the
        // call with a reason the model can act on, rather than sending the
        // platform a call with no page in it.
        const base = stamped ?? event?.params ?? {};
        const inlined = await inlineArtifactFile(base, workspaceDir());
        if (inlined && inlined.error) {
          console.error(`[knox-report-outcome] publish_artifact file_path refused: ${inlined.error}`);
          return { block: true, blockReason: inlined.error };
        }
        if (inlined && inlined.params) {
          console.error(
            `[knox-report-outcome] attached ${String(base.file_path)} ` +
              `(${Buffer.byteLength(String(inlined.params.html ?? ""), "utf8")} bytes) to publish_artifact`,
          );
          return { params: inlined.params };
        }
        return stamped ? { params: stamped } : undefined;
      },
      { priority: 40 },
    );
  },
});

/**
 * The session-id half: the params with the runtime-derived conversation id (or
 * task id) stamped on, or null when there is nothing to change.
 */
function stampSession(event, ctx) {
  const toolName = event?.toolName;

  // escalate_to_human and send_customer_email both PARK the session they are
  // called from until a human answers (0048 / 0068). From a TASK session that
  // means parking the task itself, so they take `task_id` (the plugin cannot
  // derive a work conversation from a `task:` key — the platform resolves it
  // from the task). From a webchat/a2a session they park the conversation and
  // fall through to the normal conversation_id stamping below.
  // ask_question / submit_for_review (0125) never park, but take the same
  // task_id-in-a-task-session link so the console shows where they came from.
  // create_reminder (0137) takes it to find who the reminder reports to, and
  // the artifact tools (0138) to find whose page it is and what may be read back.
  if (
    isEscalateToHumanTool(toolName) ||
    isSendCustomerEmailTool(toolName) ||
    isLearningLinkTool(toolName) ||
    isCreateReminderTool(toolName) ||
    isArtifactSessionTool(toolName)
  ) {
    const taskId = taskIdFromSessionKey(ctx?.sessionKey);
    if (taskId) {
      const params = buildOutcomeParams(event?.params ?? {}, taskId, "task_id");
      if (!params) return null;
      const parkLabel = String(toolName).split(/[.:/]|__/).pop();
      console.error(
        `[knox-report-outcome] stamped task_id=${taskId} onto ` +
          `${parkLabel} (session=${ctx?.sessionKey})`,
      );
      return params;
    }
  }

  const param = conversationIdParamFor(toolName);
  if (!param) return null;
  const sessionKey = ctx?.sessionKey;
  const conversationId = conversationIdFromSessionKey(sessionKey);
  const label = String(toolName).split(/[.:/]|__/).pop();
  if (!conversationId) {
    // No usable session key → let the call through unchanged. Fail-open, but
    // the two tools degrade differently, so say which:
    //   report_outcome — the platform rejects a blank conversation_id and the
    //     console idle-sweep backstops the session close.
    //   start_task — the task still runs, but with no parent session it posts
    //     no card and wakes nobody. On a `task:` session key that is correct (a
    //     sub-task has no conversation); anywhere else it means a result is
    //     about to go undelivered.
    console.error(
      `[knox-report-outcome] ${label} with no derivable conversation id ` +
        `(session=${sessionKey ?? "undefined"})` +
        (isStartTaskTool(toolName)
          ? " — the task will run without a parent session: no card, no callback"
          : ""),
    );
    return null;
  }
  const params = buildOutcomeParams(event?.params ?? {}, conversationId, param);
  if (!params) return null; // already correct → no change to the tool call
  // conversation_id is the session's own id (not a secret) — safe to log.
  console.error(
    `[knox-report-outcome] stamped ${param}=${conversationId} onto ` +
      `${label} (session=${sessionKey})`,
  );
  return params;
}
