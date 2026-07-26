# knox-report-outcome (OpenClaw plugin)

The OpenClaw half of per-session **outcome tracking** (knoxville-ai-console
migration 0039).

Its job: when the agent closes its session by calling the platform
`report_outcome` MCP tool, stamp the **conversation id** onto that call — because
`report_outcome` requires it, but the model does not know it and must not type
it. The runtime does know it (it is the session the turn is serving), so the
runtime supplies it.

## How it fits together

```
platform ──POST /conversations/{id}/messages──▶ agent-core shim
   shim ──chat/completions (x-openclaw-session-key: webchat:<conv> | a2a:<conv>)──▶ openclaw gateway
                                                                       │
   model, as its final act, calls report_outcome({ status, summary })  │
                        this plugin, before_tool_call on `report_outcome`:
                          conversation_id = <conv> derived from ctx.sessionKey
                          → params.conversation_id = <conv>
   openclaw ──tools/call report_outcome({ conversation_id, status, summary })──▶ platform MCP
```

The model authors `status` (`success` | `failure` | `error` | `unknown`) and a
1-2 sentence `summary`. The plugin authors nothing but the `conversation_id`,
which it takes verbatim from the OpenClaw session key. No shim staging or
loopback call is needed — the conversation id already rides the session key.

## Loading

`buildOpenclawConfig` (in `src/provision/render-workspace.ts`) wires this plugin
into `openclaw.json` **only when `PLATFORM_MCP_URL` is set** (the only path by
which `report_outcome` can reach the platform), alongside the delegated-credentials
plugin:

```jsonc
"plugins": {
  "load":    { "paths": [".../openclaw-plugins/report-outcome"] },
  "entries": { "knox-report-outcome": { "enabled": true } }
}
```

It resolves `openclaw/plugin-sdk` because `openclaw` is a direct dependency of
agent-core (`package.json`), so it is present in `node_modules` next to the
plugin at runtime.

## Guarantees

- **Runtime supplies the id.** The model never sees or types `conversation_id`;
  the plugin sets it authoritatively from `ctx.sessionKey`, overriding any value
  the model tried to supply (a hallucinated id would be rejected by the platform
  anyway).
- **Right session, every time.** The id comes from the session key, so a
  delegated (A2A) turn reports on the delegated conversation it was given and a
  webchat turn reports on its own.
- **Transcript-safe.** `before_tool_call` rewrites tool *execution* params; the
  assistant message the model produced is untouched.
- **Fail-open.** On a session key it cannot read, it leaves the call unchanged;
  the platform rejects a blank id and the console idle-sweep cron closes the
  session as `unknown` instead.

## OpenClaw assumptions (verified against `openclaw@2026.5.20`)

These are the load-bearing facts this plugin relies on. If OpenClaw is upgraded,
re-verify them.

1. `api.on("before_tool_call", handler)` runs per tool call **including MCP-server
   tools**, with `ctx.sessionKey` available, and returning `{ params }` rewrites
   the params used for execution — i.e. the arguments sent to the MCP server
   (`docs/plugins/hooks.md`: "rewrite tool params, block execution, or require
   approval"; embedded Pi exposes configured MCP tools as normal tools).
2. The shim sets the OpenClaw session key to `webchat:<conversationId>` or
   `a2a:<conversationId>` (`src/shim/routes-messages.ts`), and the platform
   `report_outcome` tool takes `conversation_id` as a call **argument**
   (knoxville-ai-console `src/lib/mcp/tools.ts`).

## Testing

**Unit (runs in CI here):** `outcome.test.js` covers the pure logic —
`isReportOutcomeTool` (bare + server-prefixed matching), `conversationIdFromSessionKey`
(prefix stripping, unreadable keys), and `buildOutcomeParams` (inject / override /
no-op / no-mutate), including the headline "reports on the exact session it is
serving" case.

**Integration (run where a real gateway is available — NOT in this repo's CI,
which has no OpenClaw runtime):** boot an agent-core container with
`PLATFORM_MCP_URL` set, send a turn, have the model call `report_outcome` with a
status + summary (no conversation id), and assert the platform recorded the
outcome against the turn's conversation.
