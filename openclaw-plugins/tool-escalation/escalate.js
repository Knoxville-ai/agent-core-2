/**
 * Pure logic for the Knox tool-escalation gate, split from index.js so it can be
 * unit-tested without loading the openclaw plugin SDK (mirrors delegated-
 * credentials/inject.js).
 */

export const PLUGIN_ID = "knox-tool-escalation";

/**
 * Parse `OPENCLAW_TOOLS_ESCALATE` — the console-composed set of runtime tool ids
 * (e.g. `odoo_production__ap_get_purchase_order`) an operator flagged as needing
 * human approval — into a de-duplicated Set. Same tokenization as the vessel's
 * `parseToolsDeny` (comma / whitespace / newline separated). Empty or non-string
 * input yields an empty Set. Never throws.
 */
export function parseEscalateList(raw) {
  const set = new Set();
  if (!raw || typeof raw !== "string") return set;
  for (const tok of raw.split(/[\s,]+/)) {
    const t = tok.trim();
    if (t) set.add(t);
  }
  return set;
}

/** True when this tool must be gated behind human approval. */
export function shouldEscalate(toolName, escalateSet) {
  return (
    typeof toolName === "string" &&
    toolName.length > 0 &&
    escalateSet.has(toolName)
  );
}

/**
 * The `before_tool_call` result that gates a tool behind human approval. Uses
 * openclaw's native `requireApproval`, so the run SUSPENDS until a decision
 * comes back rather than the plugin blocking synchronously (a human never
 * answers inside the per-call model timeout). Fail-closed: `timeoutBehavior:
 * "deny"` means a decision that never arrives denies the call, because the
 * operator explicitly required approval for this tool.
 */
export function buildApprovalResult(toolName) {
  return {
    requireApproval: {
      title: `Approval required: ${toolName}`,
      description:
        `An operator flagged "${toolName}" as requiring human approval before ` +
        `it runs on this agent. Approve to run it once, or deny to block it.`,
      severity: "critical",
      timeoutBehavior: "deny",
      allowedDecisions: ["allow-once", "deny"],
      pluginId: PLUGIN_ID,
    },
  };
}

/**
 * The whole decision for one tool call: return the approval-gate result when the
 * tool is flagged, else `null` (leave the call unchanged). Exported so the hook
 * in index.js is a thin wrapper and the branching is unit-tested here.
 */
export function decideForTool(toolName, escalateSet) {
  if (escalateSet.size === 0) return null;
  if (!shouldEscalate(toolName, escalateSet)) return null;
  return buildApprovalResult(toolName);
}
