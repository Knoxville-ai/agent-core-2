import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { AgentStorage } from "../provision/supabase-storage.js";

/**
 * Lists the agent's knowledge files (Supabase `knowledge/` prefix) for the
 * per-turn `# KNOWLEDGE` index injected into the prompt, so the agent always
 * knows which reference documents exist and can `read_knowledge` them on demand
 * — no boot/redeploy required to see a newly-uploaded file.
 *
 * Cached with a short TTL so a burst of turns in one conversation doesn't list
 * Storage every time, while a file change still appears within seconds. One
 * agent per container, so a single module-level cache is correct. Fail-open:
 * a Storage hiccup returns the last known list (or empty), never throws.
 */

const TTL_MS = 30_000;
let cache: { at: number; names: string[] } | null = null;

export async function listKnowledgeNames(env: AgentEnv): Promise<string[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.names;
  try {
    const names = (await new AgentStorage(env).list("knowledge"))
      .filter((n) => !n.startsWith("."))
      .sort();
    cache = { at: now, names };
    return names;
  } catch (err) {
    log.warn("knowledge index list failed", { err: String(err) });
    return cache?.names ?? [];
  }
}
