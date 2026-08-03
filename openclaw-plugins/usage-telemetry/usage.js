/**
 * Pure helpers for the usage-telemetry plugin. Kept separate from `index.js` so
 * they can be unit-tested without loading the OpenClaw plugin SDK.
 */

/** Coerce an unknown into a finite, non-negative integer, or 0. */
function count(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/**
 * Normalize one `llm_output` hook event into a usage sample.
 *
 * OpenClaw hands us the already-normalized shape
 * `{ input, output, cacheRead, cacheWrite, total }` — the SAME breakdown its
 * OpenAI-compat `/v1/chat/completions` endpoint throws away when it flattens
 * `prompt_tokens = input + cacheRead` (see `toOpenAiChatCompletionsUsage` in
 * openclaw's `usage-*.js`). That flattening is exactly why this plugin exists:
 * the shim cannot recover cache hit/miss from the SSE `usage` frame, so we
 * intercept it one layer up, where the split is still intact.
 *
 * Returns `null` when the event carries no usable usage, so the caller can skip
 * the round trip entirely.
 */
export function normalizeUsageEvent(event) {
  const usage = event?.usage;
  if (!usage || typeof usage !== "object") return null;

  const input = count(usage.input);
  const output = count(usage.output);
  const cacheRead = count(usage.cacheRead);
  const cacheWrite = count(usage.cacheWrite);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null;

  const sample = { input, output, cache_read: cacheRead, cache_write: cacheWrite };
  const total = count(usage.total);
  if (total > 0) sample.total = total;

  // `resolvedRef` keeps the provider prefix (e.g. "openrouter/qwen/qwen3.7-plus"),
  // which is what actually priced the call — more precise than provider+model
  // recombined, and the value the console's model_prices lookup wants.
  if (typeof event?.provider === "string" && event.provider) sample.provider = event.provider;
  if (typeof event?.model === "string" && event.model) sample.model = event.model;
  if (typeof event?.resolvedRef === "string" && event.resolvedRef) {
    sample.resolved_ref = event.resolvedRef;
  }
  return sample;
}

/**
 * Build the loopback ingest URL + auth for the shim's `/internal/llm-usage`
 * route. Read at CALL time rather than module load: OpenClaw evaluates plugin
 * modules in more than one realm during a run, and a realm evaluated before the
 * env was populated would otherwise bind an empty token forever. This mirrors
 * `loopbackConfig()` in the delegated-credentials plugin.
 */
export function loopbackConfig() {
  const port = process.env.AGENT_HTTP_PORT || "8080";
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || "";
  return { port, token, url: `http://127.0.0.1:${port}/internal/llm-usage` };
}
