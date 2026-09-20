# knox-tool-telemetry

Surfaces and records **every tool call the agent makes** — in web-chat sessions,
long-running tasks, and routine runs alike.

## Why

OpenClaw runs the agentic tool loop internally. The shim reaches it over the
OpenAI-compat `/v1/chat/completions` endpoint, whose stream carries only
assistant *content* deltas — the tool calls the model makes never appear on it
(`iterOpenaiDeltas` drops the tool-call branch on purpose). So tool use was
invisible: not shown in the session, not stored, impossible to report or bill on.

The `before_tool_call` hook fires once per tool invocation with the tool name and
params intact — the same hook the delegated-credentials / report-outcome /
task-progress plugins already use. This plugin forwards a small, **redacted**
record of each call to the shim over the same loopback + gateway-token channel the
usage-telemetry plugin uses.

```
model calls a tool
      │  before_tool_call (this plugin)
      ▼
  POST http://127.0.0.1:<shim>/internal/tool-call   { phase:"start", session_key,
        tool_name, server, tool_call_id?, args_preview(redacted) }
      │
  shim → insert public.agent_tool_calls (keyed to the live turn's conversation /
        task / assistant message)  →  console renders it live over realtime
      │
      │  after_tool_call (best-effort)
      ▼
  POST .../internal/tool-call   { phase:"end", session_key, status, duration_ms }
      │
  shim → update the row's status (ok|error) + duration
```

## Boundaries

- **Fire-and-forget.** A failed or slow POST never delays or breaks a tool call;
  every error is swallowed and the request is not awaited on the critical path.
- **Redacted by construction.** Arguments go through `redactArgs` *inside the
  gateway*, before anything crosses even the loopback route, so a secret never
  leaves the process. Credential-shaped keys (`*token*`, `*secret*`, `*api_key*`,
  `auth*`, …) are withheld; the `exec` tool's `env` bag — where the
  delegated-credentials plugin injects brokered API keys — is summarized to key
  **names** only; every value is size-bounded. See `redact.js`.
- **Observe-only.** Unlike the injector plugins, `before_tool_call` here returns
  void, so the tool call itself is never rewritten.
- **Per-session attribution.** The shim maps `ctx.sessionKey`
  (`webchat:` / `a2a:` / `task:`) to the turn it opened, so a call is attributed
  to the right conversation or task and never leaks across turns.

## Assumptions to re-verify on an OpenClaw upgrade

1. `api.on("before_tool_call", handler)` runs once per tool call with
   `ctx.sessionKey` available and `event.toolName` / `event.params` populated
   (`docs/plugins/hooks.md`). This is load-bearing and shared with three shipping
   plugins.
2. `after_tool_call` is best-effort: if it is absent or renamed, enrichment is
   skipped and rows stay `status='called'`. Nothing else depends on it.

Enabled on **every** vessel by `src/provision/render-workspace.ts` (like
usage-telemetry), gated by the `AGENT_TOOL_CALL_TRACKING` env flag. The pure
redaction/derivation helpers live in `redact.js` and are unit-tested in
`redact.test.js`.
