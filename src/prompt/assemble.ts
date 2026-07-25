import type { AgentBundle } from "../bundle/types.js";

/**
 * Assemble the SOUL.md the agent boots against. This is the STATIC layer: it is
 * written to workspace/SOUL.md once at boot and openclaw re-injects it as the
 * system prompt on every turn. Anything that varies per caller/turn (who is
 * calling, freshly-written memory) is NOT here — it is injected by the shim as a
 * `# DYNAMIC CONTEXT` system message per turn (see src/shim/routes-messages.ts).
 *
 * Section order:
 *   1. `# CONSTITUTION` — the platform-wide "soul" shared by every agent (from
 *      the image `prompts/constitution.md`, overridable via Storage
 *      `platform/constitution.md`). Never empty.
 *   2. `# IDENTITY` — this agent's charter (from storage `memory/identity.md`).
 *      Also mirrored into AGENTS.md by render-workspace.
 *   3. `# CHARTER` — optional extended domain prose (from storage
 *      `memory/system_prompt.md`, repurposed from the old "base" layer).
 *   4. `# CAPABILITIES` — one section per bundle capability, in the bundle's
 *      stable order, each fenced with `## Capability: <name>`.
 *   5. `# DELEGATION` — the agents this agent may call (its outbound
 *      connections) and when/how to reach each.
 *   6. `# OPERATOR NOTES` — optional console-authored notes (from storage
 *      `memory/playbook.seed.md`), read-only, re-rendered every boot.
 *   7. `# MEMORY` — optional boot snapshot digest of the agent's durable
 *      learned memories (from Postgres `agent_memories`).
 *   8. `# PLAYBOOK` — optional agent-owned, self-edited playbook (restored from
 *      the volume / Storage mirror).
 *   9. `# MEMORY & SELF-EDITING` — a constant footer telling the agent how its
 *      memory works and that sections 7/8 are a boot snapshot, not live state.
 *
 * The bundle's assignments come from listBundlesForAgent already sorted by
 * (listing.slug, capability.id) — we preserve that order. Connections arrive
 * pre-sorted by display name.
 */

export interface AssembleInput {
  /** Platform constitution — the shared soul. Never null (image fallback). */
  constitution: string;
  /** This agent's identity/charter block. */
  identity: string;
  /** Optional extended charter prose (repurposed `memory/system_prompt.md`). */
  charter?: string | null;
  bundle: AgentBundle | null;
  /** Optional console-authored operator notes (`memory/playbook.seed.md`). */
  operatorNotes?: string | null;
  /** Optional boot digest of durable memories (from `agent_memories`). */
  memoryDigest?: string | null;
  /** Optional agent-owned playbook (`workspace/playbook.md`). */
  playbook?: string | null;
}

const SELF_EDITING_FOOTER = `You have durable memory that outlives this session, reached through the
\`knoxville_platform\` MCP server:

- \`remember\` — save a durable fact, preference, or lesson.
- \`recall\` — look up what you already know before assuming or asking.
- \`record_org_preference\` — save how a specific calling organization likes
  things done.
- \`get_caller_context\` — retrieve what you know about whoever is calling you.

The \`# MEMORY\` and \`# PLAYBOOK\` sections above are a snapshot taken at
startup, not a live view — when accuracy matters, call \`recall\` for the
current state. Write a memory the moment you learn something durable; do not
wait for the end of a task. When another agent or organization is calling you, a
\`# DYNAMIC CONTEXT\` message may precede the conversation with who they are and
what you have learned about them.`;

/** A titled section: `--- \n\n# TITLE\n\n<body>`, or "" when body is blank. */
function section(title: string, body: string | null | undefined): string {
  const trimmed = (body ?? "").trim();
  if (!trimmed) return "";
  return ["---", "", `# ${title}`, "", trimmed].join("\n");
}

export function assembleSystemPrompt(input: AssembleInput): string {
  const parts: string[] = [];

  // 1. Constitution (never empty — the image copy is the guaranteed fallback).
  parts.push(input.constitution.trimEnd());

  // 2. Identity.
  parts.push("");
  parts.push(section("IDENTITY", input.identity));

  // 3. Optional extended charter.
  const charter = section("CHARTER", input.charter);
  if (charter) {
    parts.push("");
    parts.push(charter);
  }

  // 4. Capabilities — one fenced section per bundle capability. Preserved
  //    verbatim from the pre-constitution assembler.
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

  // 5. Delegation — outbound connections. Preserved verbatim.
  const connections = input.bundle?.connections ?? [];
  if (connections.length > 0) {
    const connParts = connections.map((c) => {
      const heading = c.label ? `${c.displayName} (${c.label})` : c.displayName;
      const instr = (c.instructions ?? "").trim();
      return [
        `## Connection: ${heading}`,
        `_target agent uid: ${c.targetAgentUid}_`,
        "",
        instr || "_No usage instructions provided._",
      ].join("\n");
    });
    parts.push("");
    parts.push("");
    parts.push("# DELEGATION");
    parts.push("");
    parts.push(
      "You can delegate to the following agents in your organization instead " +
        "of doing their work yourself. Each block says when to reach for that " +
        "agent. To delegate, use the `knoxville_platform` MCP server: call " +
        "`start_agent_conversation` with the target's uid to open a " +
        "conversation, then `send_message` to ask and read the reply. For work " +
        "that may take minutes, use `start_task` + `wait_for_task` instead. " +
        "Only the agents listed here are reachable — do not attempt to contact " +
        "any other agent.\n\n" +
        "A reply from one of these agents may come back as a structured " +
        "multiple-choice question instead of plain text (the agent needs a " +
        "decision to continue). When that happens, first try to answer it " +
        "yourself: `recall` your own memory and check your playbook for a " +
        "standing preference that settles it, and if one does, answer the agent " +
        "directly with `send_message`. Only escalate to your user — by asking " +
        "them the same multiple-choice question — when you genuinely cannot " +
        "decide, then relay their answer back to the agent that asked.",
    );
    parts.push("");
    parts.push(connParts.join("\n\n"));
  }

  // 6-8. Operator notes, memory digest, agent playbook (all optional).
  for (const [title, body] of [
    ["OPERATOR NOTES", input.operatorNotes],
    ["MEMORY", input.memoryDigest],
    ["PLAYBOOK", input.playbook],
  ] as const) {
    const s = section(title, body);
    if (s) {
      parts.push("");
      parts.push("");
      parts.push(s);
    }
  }

  // 9. Constant self-editing footer.
  parts.push("");
  parts.push("");
  parts.push(section("MEMORY & SELF-EDITING", SELF_EDITING_FOOTER));

  parts.push("");
  return parts.join("\n");
}
