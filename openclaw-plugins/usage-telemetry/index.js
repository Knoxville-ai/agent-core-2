import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { loopbackConfig, normalizeUsageEvent } from "./usage.js";

/**
 * Knox usage telemetry — recovers the prompt-cache breakdown the OpenAI-compat
 * endpoint discards.
 *
 * Why this exists
 * ---------------
 * The shim reads token usage off the SSE `usage` frame of openclaw's
 * `/v1/chat/completions`. That endpoint computes `prompt_tokens = input +
 * cacheRead` and emits only `{prompt_tokens, completion_tokens, total_tokens}` —
 * the cache read/write split is gone by the time the shim sees it. So the
 * platform could never answer "what is our cache hit rate?", even though
 * `model_prices.cached_input_usd_per_mtok` prices cache reads ~5x cheaper.
 *
 * The `llm_output` hook fires ONE LEVEL UP, per model call, with the normalized
 * `{input, output, cacheRead, cacheWrite, total}` intact. We forward each sample
 * to the shim over the same loopback + gateway-token channel the
 * delegated-credentials plugin uses, and the shim folds the totals into the
 * assistant row's `token_usage`.
 *
 * Granularity note: `llm_output` fires per MODEL CALL, not per turn. A single
 * agentic turn runs many. That is the point — it gives the shim a real
 * `model_calls` count per turn, which is the loop-iteration number the platform
 * has never been able to measure.
 *
 * Boundaries:
 *   - Fire-and-forget. A failed or slow POST must never delay or break a turn,
 *     so every error is swallowed and the request is not awaited by the model
 *     loop's critical path.
 *   - Carries token COUNTS only. No prompt text, no assistant text, no tool
 *     arguments ever cross this route.
 */

const POST_TIMEOUT_MS = 2000;

/** POST one sample to the shim. Never throws, never blocks a turn. */
async function reportUsage(sessionKey, sessionId, sample) {
  const { token, url } = loopbackConfig();
  if (!token) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        // `session_id` is openclaw's session id — the SAME id it stamps on the
        // request as `prompt_cache_key`, which the shim's cost proxy sums each
        // turn's actual OpenRouter cost under. The shim uses it to attach that
        // cost to this turn. Carries token COUNTS + ids only, never text.
        body: JSON.stringify({
          session_key: sessionKey ?? null,
          session_id: sessionId ?? null,
          sample,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* fail open — telemetry must never cost a turn */
  }
}

export default definePluginEntry({
  id: "knox-usage-telemetry",
  name: "Knox Usage Telemetry",
  description:
    "Forward per-model-call token usage (including the prompt-cache read/write split) to the agent-core shim over loopback.",
  register(api) {
    api.on(
      "llm_output",
      async (event, ctx) => {
        const sample = normalizeUsageEvent(event);
        if (!sample) return;
        await reportUsage(
          ctx?.sessionKey ?? event?.sessionKey,
          event?.sessionId ?? ctx?.sessionId,
          sample,
        );
      },
      { priority: 40 },
    );
  },
});
