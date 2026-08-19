import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { AgentStorage } from "../provision/supabase-storage.js";

/**
 * Console-managed tool policy — `config/tool_policy.json` in the agent's
 * Storage prefix, read at boot exactly like `config/skills.json`.
 *
 * **Why this exists:** every model call carries the full schema of every tool
 * the agent can reach. An agent bound to the Odoo MCP ships ~127 tool schemas —
 * on the order of 40k tokens — on *every* call, whether or not the turn is
 * about Odoo. A browser-workflow agent that only ever runs `exec` and the
 * platform MCP pays that on each of its turns for nothing.
 *
 * `OPENCLAW_TOOLS_ALLOW` / `_DENY` already do this, but only as Railway env
 * vars: setting them means a redeploy, and they are per-service rather than
 * per-agent-role. This is the same lever sourced from Storage, so the console
 * can change it without restarting anything and without a new wire protocol.
 *
 * Shape:
 *   {
 *     "version": 1,
 *     "profile": "minimal" | "coding" | "messaging" | "full",   // optional
 *     "allow":     ["exec", "group:openclaw", "knoxville_platform__*"],
 *     "alsoAllow": ["odoo_production__sales_*"],
 *     "deny":      ["odoo_production__*"]
 *   }
 *
 * Every field is optional; an absent or unparseable file yields an empty policy
 * and the vessel behaves exactly as before.
 */

const TOOL_POLICY_KEY = "config/tool_policy.json";

const PROFILES = new Set(["minimal", "coding", "messaging", "full"]);

/**
 * Tools an allowlist must contain for the agent to function at all.
 *
 * openclaw's allow semantics are **complete**: a non-empty allowlist denies
 * every tool it does not name. An allowlist that forgets these takes away
 * exec, delegation, memory and outcome reporting — the agent boots, answers,
 * and can do nothing, with no error to explain it. So rather than trusting the
 * console to remember, they are added here.
 */
export const ALLOWLIST_ESSENTIALS = [
  "group:openclaw",
  "group:plugins",
  "knoxville_platform__*",
];

export interface ToolPolicy {
  profile?: string;
  allow: string[];
  alsoAllow: string[];
  deny: string[];
}

export const EMPTY_TOOL_POLICY: ToolPolicy = { allow: [], alsoAllow: [], deny: [] };

/** Order-preserving dedupe of a string list from the policy file. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const token = entry.trim();
    if (token && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/**
 * Convert a parsed `config/tool_policy.json` into a policy. Pure, so it is
 * directly unit-testable, and tolerant: a malformed field is dropped rather
 * than failing the boot of an otherwise healthy agent.
 */
export function parseToolPolicy(file: unknown): ToolPolicy {
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    return { ...EMPTY_TOOL_POLICY };
  }
  const doc = file as Record<string, unknown>;

  const allow = stringList(doc.allow);
  // openclaw rejects a config setting both, and `allow` is the stronger
  // statement — so a file that sets both keeps `allow` rather than failing the
  // boot. Mirrors how the env path resolves the same conflict.
  const alsoAllow = allow.length > 0 ? [] : stringList(doc.alsoAllow);

  const profileRaw = typeof doc.profile === "string" ? doc.profile.trim() : "";
  const profile = PROFILES.has(profileRaw) ? profileRaw : undefined;
  if (profileRaw && !profile) {
    log.warn("tool policy: unknown profile ignored", { profile: profileRaw });
  }

  return {
    ...(profile ? { profile } : {}),
    // A non-empty allowlist is complete, so it must carry the essentials or the
    // agent loses exec and the platform MCP. Appended, not prepended, so an
    // explicit ordering in the file is preserved.
    allow:
      allow.length > 0
        ? [...allow, ...ALLOWLIST_ESSENTIALS.filter((t) => !allow.includes(t))]
        : [],
    alsoAllow,
    deny: stringList(doc.deny),
  };
}

/** Read + parse the tool policy from Storage. Soft: empty when absent/bad. */
export async function loadToolPolicy(env: AgentEnv): Promise<ToolPolicy> {
  const file = await new AgentStorage(env).downloadJSON<unknown>(TOOL_POLICY_KEY);
  const policy = parseToolPolicy(file);
  if (policy.allow.length || policy.alsoAllow.length || policy.deny.length || policy.profile) {
    log.info("tool policy loaded", {
      profile: policy.profile ?? null,
      allow: policy.allow.length,
      also_allow: policy.alsoAllow.length,
      deny: policy.deny.length,
    });
  }
  return policy;
}
