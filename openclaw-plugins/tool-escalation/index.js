import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { decideForTool, parseEscalateList, PLUGIN_ID } from "./escalate.js";

/**
 * Knox tool-escalation gate — the OpenClaw half of the console's per-tool
 * "requires escalation" toggle.
 *
 * The console composes the set of tools an operator flagged into the
 * `OPENCLAW_TOOLS_ESCALATE` container env var. This plugin runs on
 * `before_tool_call`: when the model tries to call a flagged tool, it returns
 * openclaw's native `requireApproval`, which SUSPENDS the run until a human
 * decision comes back (approve-once or deny). A tool that is not flagged is left
 * completely unchanged.
 *
 * Boundaries this plugin keeps:
 *   - Reads `OPENCLAW_TOOLS_ESCALATE` at CALL time, not import time (the env is
 *     populated per-realm; see delegated-credentials for the same reasoning).
 *   - Fail-closed: a flagged tool is gated; a decision that never arrives denies
 *     the call (`timeoutBehavior: "deny"` in the approval spec).
 *   - No-op when the var is empty/unset, so an agent with no flagged tools pays
 *     nothing and no tool call is ever altered.
 *   - Never throws out of the hook — a logging failure must not break a call.
 *
 * NOTE: the approval still has to be DELIVERED to a human and resolved. That is
 * openclaw's approval-broker/approver wiring (the platform side that surfaces the
 * request in the console and replies). Until that broker is wired, a flagged tool
 * fails closed (denied on timeout) — safe, but it will block rather than prompt.
 */
export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Knox Tool Escalation",
  description:
    "Gate operator-flagged tools behind human approval (requireApproval) before they run.",
  register(api) {
    api.on(
      "before_tool_call",
      async (event, ctx) => {
        const toolName = event?.toolName;
        const result = decideForTool(
          toolName,
          parseEscalateList(process.env.OPENCLAW_TOOLS_ESCALATE),
        );
        if (!result) return; // not flagged -> leave the tool call unchanged
        // One diagnostic so a gated call is traceable end-to-end (names only).
        try {
          console.error(
            `[knox-tool-escalation] gating tool=${toolName} ` +
              `session=${ctx?.sessionKey ?? "undefined"}`,
          );
        } catch {
          /* never let logging break the gate */
        }
        return result;
      },
      { priority: 20 },
    );
  },
});
