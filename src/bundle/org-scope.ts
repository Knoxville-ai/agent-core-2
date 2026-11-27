import { log } from "../log.js";
import type { AgentBundle } from "./types.js";

/**
 * The org a bundle entry says it belongs to, when the console sends one.
 * Assignments may carry the listing's org as `listing.orgId` (or
 * `listing.sourceOrgId`); a same-org connection may carry the org that owns
 * the connection as `orgId`. Older consoles send neither, and then nothing is
 * filtered here (the console scopes both lists to the agent's org itself).
 */
function declaredOrg(entry: unknown, ...keys: string[]): string | null {
  if (!entry || typeof entry !== "object") return null;
  const rec = entry as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Keep only the bundle entries configured by the agent's own org: an
 * assignment whose listing declares another org, or a connection whose owning
 * org is another org, is dropped (its prompt fragment, skill and instructions
 * never reach this agent). Entries that declare no org are kept. Cross-org
 * drive-thru connections are vendor listings by design and are not filtered.
 * Returns a new bundle; the input is not mutated.
 */
export function scopeBundleToOrg(bundle: AgentBundle, agentOrg: string | null | undefined): AgentBundle {
  const org = (agentOrg ?? "").trim();
  if (!org) return bundle;
  const assignments = bundle.assignments.filter((a) => {
    const o = declaredOrg(a.listing, "orgId", "sourceOrgId");
    return o === null || o === org;
  });
  const connections = (bundle.connections ?? []).filter((c) => {
    const o = declaredOrg(c, "orgId");
    return o === null || o === org;
  });
  const dropped =
    bundle.assignments.length - assignments.length + ((bundle.connections ?? []).length - connections.length);
  if (dropped > 0) {
    log.warn("bundle entries from another org ignored", {
      assignments: bundle.assignments.length - assignments.length,
      connections: (bundle.connections ?? []).length - connections.length,
    });
  }
  if (dropped === 0) return bundle;
  return { ...bundle, assignments, connections };
}
