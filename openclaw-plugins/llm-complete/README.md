# knox-llm-complete (OpenClaw plugin)

A loopback, one-shot completion on the agent's **own** model, for the shim's
side tasks. Its first user is conversation naming
(`src/shim/conversation-title.ts`).

## Why it exists

The shim only reaches the model through openclaw's `/v1/chat/completions`,
which runs a full agent turn: the whole system prompt (SOUL.md alone is ~40–50k
chars), every tool schema, a session transcript. Right for a reply; absurd for
"name this conversation in five words". Calling the provider directly instead
would mean re-implementing openclaw's model, auth and base-URL resolution, and
it cannot work at all on Codex OAuth, where only openclaw can read the token.

openclaw already has the right primitive: `api.runtime.llm.complete`, a
host-owned single completion that resolves the agent's default model,
credentials (API key or OAuth profile) and base URL (so OpenRouter traffic still
flows through the cost proxy), with no prompt, tools or session of its own. This
plugin puts it on a gateway HTTP route.

## Route

```
POST http://127.0.0.1:<OPENCLAW_GATEWAY_PORT>/knox/llm-complete
Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>

{ "system": "…", "messages": [{ "role": "user", "content": "…" }],
  "max_tokens": 1024, "timeout_ms": 30000, "purpose": "knox-conversation-title" }

200 { "text": "…", "provider": "openrouter", "model": "…",
      "usage": { "input_tokens": 210, "output_tokens": 6, "cost_usd": 0.00004 } }
```

`400` malformed request · `405` not a POST · `501` this openclaw has no
completion runtime · `502` the model call failed · `504` it ran past
`timeout_ms`. A caller that hangs up aborts the model call.

## Boundaries

- **Same trust anchor as the turn route.** Gateway-token auth on a
  loopback-bound gateway, exactly like the chat-completions call the shim
  already makes, which can do strictly more than this.
- **Always the agent's default model.** There is no model field; the
  completion runtime's own override policy stays closed.
- **Stateless.** No session, no transcript, no tools. The text goes back to the
  caller and nowhere else.

Wired on every vessel by `buildOpenclawConfig`
(`src/provision/render-workspace.ts`). It does nothing until called.
