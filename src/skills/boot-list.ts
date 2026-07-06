import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import type { SkillRequirement } from "../bundle/types.js";
import { AgentStorage } from "../provision/supabase-storage.js";

/**
 * Console-managed skill boot list — `config/skills.json` in the agent's Storage
 * prefix. This is the durable, per-agent skill list the console's agent-skills
 * UI writes (see knoxville-ai-console `src/lib/skills.ts#writeSkillBootList`).
 * The vessel installs every entry on boot so console-added skills survive
 * container restarts — the boot pipeline wipes `workspace/skills/` and
 * reconciles from source, so a skill that isn't in the bundle OR this list is
 * not persisted.
 *
 * Shape written by the console:
 *   { "version": 1, "skills": [ { "slug": string, "version": string|null, "addedAt": ISO } ] }
 */

const BOOT_LIST_KEY = "config/skills.json";

/**
 * Convert a parsed `config/skills.json` document into clawhub SkillRequirements.
 * Pure (no IO) so it is directly unit-testable. Tolerant of malformed entries:
 * anything without a string `slug` is skipped; duplicate slugs are de-duped;
 * a missing/null `version` becomes "" (install the latest, no `--version` pin).
 */
export function parseBootList(file: unknown): SkillRequirement[] {
  const skills =
    file && typeof file === "object" && Array.isArray((file as { skills?: unknown }).skills)
      ? (file as { skills: unknown[] }).skills
      : [];
  const out: SkillRequirement[] = [];
  const seen = new Set<string>();
  for (const entry of skills) {
    if (!entry || typeof entry !== "object") continue;
    const slug = (entry as { slug?: unknown }).slug;
    if (typeof slug !== "string") continue;
    const ref = slug.trim();
    if (ref === "" || seen.has(ref)) continue;
    seen.add(ref);
    const rawVersion = (entry as { version?: unknown }).version;
    const version = typeof rawVersion === "string" ? rawVersion.trim() : "";
    out.push({ source: "clawhub", ref, version });
  }
  return out;
}

/** Read + parse the boot list from Storage. Soft: [] when absent/unparseable. */
export async function loadBootListSkills(env: AgentEnv): Promise<SkillRequirement[]> {
  const file = await new AgentStorage(env).downloadJSON<unknown>(BOOT_LIST_KEY);
  const reqs = parseBootList(file);
  if (reqs.length > 0) {
    log.info("skill boot list loaded", {
      count: reqs.length,
      skills: reqs.map((r) => (r.version ? `${r.ref}@${r.version}` : r.ref)),
    });
  }
  return reqs;
}
