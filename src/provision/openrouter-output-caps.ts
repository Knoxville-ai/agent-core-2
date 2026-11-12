import { log } from "../log.js";
import type { AgentEnv } from "../env.js";

/**
 * Output-token caps for the OpenRouter models this agent overlays in
 * openclaw.json (see buildProviderConfig in render-workspace.ts).
 *
 * Why this exists: openclaw reads an OpenRouter model's max output from the
 * public catalog (`top_provider.max_completion_tokens`) and sends it as every
 * call's max_tokens. OpenRouter rejects a call whose prompt + max_tokens is
 * larger than the context window, and some listings reserve nearly all of it:
 * z-ai/glm-5.2 lists 943,718 of a 1,048,576 window, which leaves ~105k tokens
 * for the prompt. An agent's system prompt and tool schemas alone can take most
 * of that, so a long session soon fails every call. openclaw reads the 400 as a
 * context overflow and compacts, which can't help (compaction shrinks the
 * history, not the reservation or the tool schemas), then gives up mid-turn.
 *
 * A `maxTokens` on a models[] overlay entry replaces the catalog value (openclaw
 * 2026.5.20, applyConfiguredProviderOverrides: configured ?? provider ??
 * discovered). It replaces in both directions, so writing the cap for every
 * model would also RAISE a smaller limit, and OpenRouter refuses a call that
 * asks for more output than the model allows. So the cap is written only for a
 * model whose listing is known to exceed it; a smaller or unknown listing keeps
 * openclaw's own value. The listings come from the same public catalog openclaw
 * reads, fetched once at boot.
 *
 * Fail-open: a failed fetch yields no caps and never blocks boot. The cost proxy
 * (shim/cost-proxy.ts) lowers every call's max_tokens to the same cap anyway, so
 * the overlay fixes openclaw's own view of the model and the proxy is the
 * backstop for everything else (a model the overlay missed, a failed fetch).
 *
 * Boot-time snapshot, like pinnable-models.ts: a listing that changes later is
 * picked up on the agent's next boot.
 */

/** The catalog openclaw's OpenRouter provider reads model limits from. */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** The same timeout openclaw gives its own fetch of the catalog. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch OpenRouter's public model catalog (its `data` array). Null when the
 * provider isn't OpenRouter (nothing to cap) or the fetch fails. Never throws.
 */
export async function fetchOpenRouterCatalog(
  env: AgentEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown[] | null> {
  if (env.LLM_PROVIDER.trim().toLowerCase() !== "openrouter") return null;
  try {
    const res = await fetchImpl(OPENROUTER_MODELS_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn("openrouter catalog: fetch failed; no output caps in openclaw.json", {
        status: res.status,
      });
      return null;
    }
    const body = (await res.json()) as { data?: unknown } | null;
    return Array.isArray(body?.data) ? body.data : null;
  } catch (err) {
    log.warn("openrouter catalog: fetch threw; no output caps in openclaw.json", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * A catalog entry's listed max output, read the way openclaw reads it: the
 * first of top_provider.max_completion_tokens, max_completion_tokens and
 * max_output_tokens that is set. Undefined unless that is a positive number
 * (with none set, openclaw uses 8192, which no cap needs to lower).
 */
export function listedMaxOutputTokens(entry: unknown): number | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as Record<string, unknown>;
  const top =
    e.top_provider && typeof e.top_provider === "object"
      ? (e.top_provider as Record<string, unknown>)
      : {};
  const listed = top.max_completion_tokens ?? e.max_completion_tokens ?? e.max_output_tokens;
  return typeof listed === "number" && Number.isFinite(listed) && listed > 0 ? listed : undefined;
}

/**
 * The overlay caps for `modelIds`: `cap` for each model whose listed max output
 * exceeds it, and nothing for the rest. `catalog` is the catalog's `data`
 * array, or null when it couldn't be fetched (then there are no caps).
 */
export function outputCapsFor(
  catalog: readonly unknown[] | null,
  modelIds: readonly string[],
  cap: number,
): Record<string, number> {
  const caps: Record<string, number> = {};
  if (!catalog) return caps;
  const wanted = new Set(modelIds.filter(Boolean));
  if (wanted.size === 0) return caps;
  for (const entry of catalog) {
    const id = entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
    if (typeof id !== "string" || !wanted.has(id)) continue;
    const listed = listedMaxOutputTokens(entry);
    if (listed !== undefined && listed > cap) caps[id] = cap;
  }
  return caps;
}
