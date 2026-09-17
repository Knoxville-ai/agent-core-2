import { createClient } from "@supabase/supabase-js";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";

/**
 * The extra models this agent may be pinned to by a routine's per-request model
 * override (`x-openclaw-model`), beyond its container-default `LLM_MODEL`.
 *
 * Why this exists: openclaw only stamps `prompt_cache_key` on a call when the
 * RESOLVED model carries `compat.supportsPromptCacheKey` (see
 * render-workspace.ts), and the shim's cost proxy attributes each turn's actual
 * OpenRouter charge to the turn BY that session id. buildOpenclawConfig sets the
 * flag only for the models it overlays, so a routine that overrides the model to
 * one that is NOT overlaid runs with no session id — the proxy cannot attribute
 * its cost, `messages.token_usage.cost_usd` never lands, and the outcome prices
 * at 0 tokens / $0 even though real tokens were spent. Overlaying every model a
 * routine can pin closes that gap, so per-routine model selection stays
 * cost-tracked without a dedicated agent per model.
 *
 * Scope: OpenRouter-provider, available models only. Those are the ones that
 * traverse the in-shim cost proxy; a non-OpenRouter override never does, so an
 * overlay would not help it and might name a slug openclaw's OpenRouter catalog
 * cannot resolve. `LLM_MODEL` is intentionally NOT included here —
 * buildOpenclawConfig always overlays the default itself.
 *
 * Fail-open: any error returns `[]`, so a catalog/DB hiccup degrades to
 * "track the default model only" (today's behavior) and never breaks boot.
 *
 * Boot-time snapshot: the list is read once per boot and baked into
 * openclaw.json. A routine pinned to a brand-new model that no prior routine
 * used takes effect on the agent's next boot/redeploy.
 */
export async function fetchPinnableModelIds(env: AgentEnv): Promise<string[]> {
  try {
    const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: routineRows, error: routineErr } = await sb
      .from("routines")
      .select("model_id")
      .eq("agent_uid", env.AGENT_UID)
      .not("model_id", "is", null);
    if (routineErr) {
      log.warn("pinnable models: routine query failed; tracking default model only", {
        error: routineErr.message,
      });
      return [];
    }

    const routineModelIds = new Set<string>();
    for (const row of routineRows ?? []) {
      const id = (row as { model_id?: unknown }).model_id;
      if (typeof id === "string" && id) routineModelIds.add(id);
    }
    if (routineModelIds.size === 0) return [];

    // Keep only models that actually route through the cost proxy (OpenRouter)
    // and are currently available — the set whose overlay is both useful and
    // safe to name to openclaw.
    const { data: modelRows, error: modelErr } = await sb
      .from("models")
      .select("id")
      .eq("provider", "openrouter")
      .eq("is_available", true)
      .in("id", [...routineModelIds]);
    if (modelErr) {
      log.warn("pinnable models: model query failed; tracking default model only", {
        error: modelErr.message,
      });
      return [];
    }

    const ids = new Set<string>();
    for (const row of modelRows ?? []) {
      const id = (row as { id?: unknown }).id;
      if (typeof id === "string" && id) ids.add(id);
    }
    const result = [...ids];
    log.info("pinnable models resolved for cost-tracking overlay", {
      agent_uid: env.AGENT_UID,
      count: result.length,
      models: result,
    });
    return result;
  } catch (err) {
    log.warn("pinnable models: fetch threw; tracking default model only", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
