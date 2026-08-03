# knox-usage-telemetry

Recovers the prompt-cache breakdown that openclaw's OpenAI-compat endpoint
discards, so the platform can finally measure its cache hit rate.

## Why it exists

The shim reads token usage off the SSE `usage` frame of openclaw's
`/v1/chat/completions`. That endpoint computes

```
prompt_tokens = input + cacheRead
```

and emits only `{prompt_tokens, completion_tokens, total_tokens}`. The cache
read/write split is gone by the time the shim sees it, so `messages.token_usage`
could never distinguish a cache hit from a miss — even though
`model_prices.cached_input_usd_per_mtok` prices cache reads roughly 5x cheaper
than fresh input.

The `llm_output` hook fires one layer up, per model call, with openclaw's
normalized `{input, output, cacheRead, cacheWrite, total}` still intact. This
plugin captures it there and forwards it to the shim.

## How it works

```
openclaw agentic loop
  └─ llm_output hook (per MODEL CALL)
       └─ POST http://127.0.0.1:${AGENT_HTTP_PORT}/internal/llm-usage
            { session_key, sample: { input, output, cache_read, cache_write, … } }
                 └─ shim UsageAccumulator (rollup, keyed by session key)
                      └─ messages.token_usage  (drained when the turn finalizes)
```

Authed with `OPENCLAW_GATEWAY_TOKEN` over loopback — the same trust anchor as
`/files`, `/skills`, and `/internal/delegated-credentials`.

## Granularity

`llm_output` fires per **model call**, not per turn. One agentic turn runs many.
That is deliberate: the rollup's `model_calls` is the agentic-loop iteration
count per turn, a number the platform previously had no way to observe.

## What lands in `token_usage`

| field | meaning |
| --- | --- |
| `input_tokens` | unchanged — still **inclusive** of cache reads |
| `uncached_input_tokens` | input billed at the full rate |
| `cache_read_input_tokens` | input served from cache (cheaper rate) |
| `cache_creation_input_tokens` | input written into the cache |
| `model_calls` | model calls in this turn (loop iterations) |
| `resolved_ref` | provider/model ref that actually priced the call |

The identity `uncached_input_tokens + cache_read_input_tokens == input_tokens`
always holds, so cost is:

```
uncached_input_tokens      * input_usd_per_mtok
+ cache_read_input_tokens  * cached_input_usd_per_mtok
+ output_tokens            * output_usd_per_mtok
```

Cache-write tokens are **not** part of `input_tokens` (the compat endpoint
excludes them) and must be priced separately.

## Boundaries

- **Fire-and-forget.** A failed or slow POST never delays or breaks a turn.
- **Counts only.** No prompt text, assistant text, or tool arguments cross this
  route.
- **Fails open.** If the plugin is not loaded, `token_usage` keeps exactly its
  previous shape — the extra fields are simply absent.

## Attribution caveat

`task:<taskId>` session keys are unique per task, so the long-running task path —
where the token volume actually is — is exact. `webchat:<convId>` keys are not
unique across simultaneous turns on one conversation; when two overlap, their
samples merge into whichever drains first. Telemetry only; it never affects a
turn's behaviour.
