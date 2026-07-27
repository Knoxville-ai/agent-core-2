import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import {
  buildProgressParams,
  isReportProgressTool,
  taskIdFromSessionKey,
} from "./progress.js";

/**
 * Knox task-progress injector — the OpenClaw half of long-running task
 * narration (knoxville-ai-console migration 0047).
 *
 * A task may run for an hour with nobody on the other end of a connection. The
 * only thing the person who asked can see while they wait is the task card in
 * their chat thread, and the only thing that updates that card mid-flight is the
 * agent calling `report_task_progress`. That tool REQUIRES a `task_id`, which
 * the model does not have and must not type — but the runtime does, because it
 * keyed the executor's session `task:<taskId>`. This plugin stamps it on.
 *
 * Same shape and the same boundaries as knox-report-outcome:
 *   - It rewrites tool *execution* params only; the assistant message the model
 *     produced is untouched.
 *   - `task_id` is the session's own id, not a secret, so logging it is fine
 *     and useful for tracing a task end-to-end.
 *   - Fail-open: on a session key it cannot read (an ordinary chat turn, say)
 *     it leaves the call unchanged and the platform rejects it — which is the
 *     correct outcome, since there is no task to report on.
 */

export default definePluginEntry({
  id: "knox-task-progress",
  name: "Knox Task Progress",
  description:
    "Stamp the platform task id onto the agent's report_task_progress MCP call so the model never has to know or type it.",
  register(api) {
    api.on(
      "before_tool_call",
      async (event, ctx) => {
        if (!isReportProgressTool(event?.toolName)) return;
        const sessionKey = ctx?.sessionKey;
        const taskId = taskIdFromSessionKey(sessionKey);
        if (!taskId) {
          console.error(
            `[knox-task-progress] report_task_progress outside a task session ` +
              `(session=${sessionKey ?? "undefined"}) — leaving the call unchanged`,
          );
          return;
        }
        const params = buildProgressParams(event?.params ?? {}, taskId);
        if (!params) return; // already correct → no change to the tool call
        console.error(
          `[knox-task-progress] stamped task_id=${taskId} onto ` +
            `report_task_progress (session=${sessionKey})`,
        );
        return { params };
      },
      { priority: 40 },
    );
  },
});
