# knox-tool-escalation

OpenClaw `before_tool_call` plugin that gates operator-flagged tools behind human
approval before they run.

## How it works

- The console's per-tool **Escalation** toggle (Agent → MCP Servers → expand a
  server → a tool) composes the set of flagged runtime tool ids
  (`<server>__<tool>`, e.g. `odoo_production__sales_confirm_order`) into the
  `OPENCLAW_TOOLS_ESCALATE` container env var.
- On every `before_tool_call`, this plugin reads that var (lazily, at call time)
  and — for a flagged tool — returns openclaw's native `requireApproval`, which
  **suspends the run** until a human decision (`allow-once` or `deny`) comes back.
  An unflagged tool is left completely unchanged.
- **Fail-closed:** the approval spec sets `timeoutBehavior: "deny"`, so a decision
  that never arrives denies the call — the operator explicitly required approval.
- **No-op when empty:** an agent with no flagged tools pays nothing and no tool
  call is ever altered. Wired only when `PLATFORM_MCP_URL` is set (approvals need
  the platform).

`escalate.js` holds the pure decision logic (unit-tested in `escalate.test.js`);
`index.js` is the thin hook wrapper — the same split as `delegated-credentials`.

## Remaining integration (platform side)

Returning `requireApproval` raises the request; **delivering** it to a human and
replying is openclaw's approval-broker/approver wiring. To surface these in the
console's escalation inbox and resolve them, the platform must act as the approver
for this agent (openclaw's `approvalPolicy` / approver channel). Until that broker
is wired, a flagged tool fails closed (denied on timeout) rather than prompting —
safe, but it blocks. Tracking that wiring is the follow-up to this plugin.
