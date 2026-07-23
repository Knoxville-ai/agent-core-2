# knox-delegated-credentials (OpenClaw plugin)

The OpenClaw half of the platform-brokered **delegated-credentials** consumer.
Its job: on an agent-to-agent (A2A) turn, make the credentials the *calling*
agent shared available to this turn's skill subprocesses as **environment
variables** — so a skill reads e.g. `SPORTSINC_API_KEY` from `os.environ`
exactly as it would standalone — **without** the secret ever entering the model
prompt, the tool call the model emitted, or the transcript.

## How it fits together

```
platform ──POST /conversations/{id}/messages (X-Knox-Caller-Kind: agent)──▶ agent-core shim
   shim: detect delegated turn → get_delegated_credentials(conv) via BundleClient
   shim: DelegatedCredentialStore.set("a2a:<conv>", { SPORTSINC_API_KEY: … })   (in-memory, per-turn)
   shim ──chat/completions (x-openclaw-session-key: a2a:<conv>)──▶ openclaw gateway
                                                                       │
                        this plugin, before_tool_call on the `exec` tool:
                          GET http://127.0.0.1:<shim>/internal/delegated-credentials?session_key=a2a:<conv>
                          merge → params.env → skill subprocess sees SPORTSINC_API_KEY
   shim: DelegatedCredentialStore.clear("a2a:<conv>")   (turn finally)
```

The shim never mutates the long-lived gateway env (that would leak across
concurrent turns and outlive the turn). Instead the creds live only in a
per-session in-memory entry and are handed to *this* session's `exec` calls via
the loopback route.

## Loading

`buildOpenclawConfig` (in `src/provision/render-workspace.ts`) wires this plugin
into `openclaw.json` **only when `PLATFORM_MCP_URL` is set** (the sole path by
which a delegated turn can arrive):

```jsonc
"plugins": {
  "load":    { "paths": [".../openclaw-plugins/delegated-credentials"] },
  "entries": { "knox-delegated-credentials": { "enabled": true } }
}
```

It resolves `openclaw/plugin-sdk` because `openclaw` is a direct dependency of
agent-core (`package.json`), so it's present in `node_modules` next to the plugin
at runtime.

## Runtime inputs (from the gateway process env, inherited from the shim)

- `AGENT_HTTP_PORT` — shim port for the loopback lookup (default `8080`).
- `OPENCLAW_GATEWAY_TOKEN` — bearer for the loopback route (same trust anchor as
  `/files`, `/skills`).

## Guarantees

- **Transcript-safe.** `before_tool_call` rewrites tool *execution* params; the
  assistant message the model produced (persisted to the session transcript) is
  untouched, and the model never sees the value.
- **Per-session isolation.** Creds are looked up by `ctx.sessionKey`; a turn only
  ever sees its own delegation. A non-delegated session gets `{}` back → no-op.
- **Fail-open, never blocks.** Any lookup error → inject nothing; the skill
  surfaces its own auth error. Nothing is logged (the response holds secrets).
- **exec-only.** Only the `exec` (host-run) tool, which accepts an `env` param,
  is touched. Other tools are left exactly as the model emitted them.

## OpenClaw assumptions (verified against `openclaw@2026.5.20`)

These are the load-bearing facts this plugin relies on. If OpenClaw is upgraded,
re-verify them (they are exactly what the integration test below checks):

1. `api.on("before_tool_call", handler)` runs per tool call, with `ctx.sessionKey`
   available, and returning `{ params }` **rewrites the params used for
   execution** (`docs/plugins/hooks.md`).
2. The agent host-run tool is named **`exec`** and accepts an **`env`**
   (`Record<string,string>`) param that is layered onto the subprocess
   environment (`src/agents/bash-tools*`). OpenClaw sanitises env overrides and
   rejects a small blocklist of keys (e.g. `PATH`); ordinary credential keys like
   `SPORTSINC_API_KEY` pass.
3. External plugins load from `plugins.load.paths` and activate via
   `activation.onStartup` (`docs/tools/plugin.md`, `docs/cli/plugins.md`).

## Testing

**Unit (runs in CI here):** `inject.test.js` covers the pure logic —
`isExecTool`, `buildInjectedParams` (inject / no-op / no-clobber / no-mutate /
key-filtering), `parseCredentialsResponse`, and the headline "delegated turn sees
the var, next turn does not" case. The shim half is covered by
`src/bundle/client.test.ts`, `src/shim/delegated-credentials.test.ts`, and
`src/shim/routes-internal.test.ts` (including value-never-logged and
two-session isolation).

**Integration (run where a real gateway is available — NOT in this repo's CI,
which has no OpenClaw runtime):**

1. Boot an agent-core container with `PLATFORM_MCP_URL` set and a skill installed
   that reads an env var (e.g. `sportsinc-sportslink`, which reads
   `SPORTSINC_API_KEY`).
2. Stub the platform MCP so `get_delegated_credentials({conversation_id})`
   returns `{ "credentials": { "SPORTSINC_API_KEY": "itest-value" } }`.
3. Send a delegated turn (`X-Knox-Caller-Kind: agent`, A2A JWT) whose skill runs
   `python3 -c 'import os;print(os.environ.get("SPORTSINC_API_KEY"))'` via `exec`.
   Assert the output is `itest-value`.
4. Send a following **non-delegated** turn running the same command; assert the
   var is absent.
5. Grep the container logs and the session transcript for `itest-value`; assert
   it appears in **neither**.
