import type { AgentBundle } from "../bundle/types.js";

/**
 * Assemble the SOUL.md the agent boots against. Order:
 *
 *   1. Base system prompt (from storage `memory/system_prompt.md`)
 *   2. Identity block (from storage `memory/identity.md`) — for the
 *      runtime view this lives in AGENTS.md, but we mirror its essentials
 *      into SOUL too so the system prompt is self-contained even if the
 *      gateway never reads AGENTS.md.
 *   3. One section per capability, in the bundle's stable order, each
 *      delimited with a fenced `## Capability: <name>` heading so the
 *      model can attribute the instructions back to a capability.
 *
 * The bundle's assignments come from listBundlesForAgent already sorted
 * by (listing.slug, capability.id) — we preserve that order.
 */

export interface AssembleInput {
  base: string;
  identity: string;
  bundle: AgentBundle | null;
}

export function assembleSystemPrompt(input: AssembleInput): string {
  const parts: string[] = [];
  parts.push(input.base.trimEnd());
  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push("# IDENTITY");
  parts.push("");
  parts.push(input.identity.trim());

  const assignments = input.bundle?.assignments ?? [];
  const capParts = assignments
    .map((a) => {
      const fragment = (a.capability.promptFragment ?? "").trim();
      if (!fragment) return null;
      return [
        "---",
        "",
        `## Capability: ${a.capability.name}`,
        `_Listing: ${a.listing.slug} · capability id: ${a.capability.id ?? "(none)"}_`,
        "",
        fragment,
      ].join("\n");
    })
    .filter((s): s is string => s !== null);

  if (capParts.length > 0) {
    parts.push("");
    parts.push("");
    parts.push("# CAPABILITIES");
    parts.push("");
    parts.push(
      "The following capability-specific instructions are loaded for this " +
        "agent. Each block applies only when the named capability is in play.",
    );
    parts.push("");
    parts.push(capParts.join("\n\n"));
  }

  parts.push("");
  return parts.join("\n");
}
