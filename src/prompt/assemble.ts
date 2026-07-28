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
  /**
   * Runtime tool ids the operator flagged as requiring human approval before use
   * (from the console per-tool policy, delivered as `OPENCLAW_TOOLS_ESCALATE`).
   * Rendered as a hard `# TOOL APPROVALS` instruction that routes each call
   * through `escalate_to_human` (console 0048) — the same mechanism as an
   * approval-gated capability. Empty/absent -> no section.
   */
  escalatedTools?: string[];
}

/**
 * Parse `OPENCLAW_TOOLS_ESCALATE` (comma / whitespace / newline separated tool
 * ids, e.g. `odoo_production__sales_confirm_order`) into a de-duplicated,
 * order-preserving list. Empty / missing -> `[]`. Never throws.
 */
export function parseEscalatedTools(raw: string | undefined | null): string[] {
  if (!raw || typeof raw !== "string") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of raw.split(/[\s,]+/)) {
    const t = tok.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
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

  // 4. Capabilities — one fenced section per bundle capability. Each carries its
  //    prompt fragment and, when the capability is flagged, the runtime-enforced
  //    approval requirement (console 0048): the flag was previously dropped here,
  //    so `requiresHumanApproval` did nothing at all. Now it becomes a hard,
  //    per-capability instruction to route the action through escalate_to_human.
  const assignments = input.bundle?.assignments ?? [];
  const capParts = assignments
    .map((a) => {
      const cap = a.capability;
      const fragment = (cap.promptFragment ?? "").trim();
      const gated = cap.requiresHumanApproval === true;
      // Nothing to render only when there is neither guidance nor a gate — a
      // gated capability MUST appear even without a fragment, or its approval
      // requirement would silently vanish.
      if (!fragment && !gated) return null;
      const lines = [
        "---",
        "",
        `## Capability: ${cap.name}`,
        `_Listing: ${a.listing.slug} · capability id: ${cap.id ?? "(none)"} · mode: ${cap.mode}_`,
        "",
      ];
      if (fragment) lines.push(fragment);
      if (gated) {
        if (fragment) lines.push("");
        lines.push(
          "> ⚠️ **Human approval required for this capability.** Before you carry " +
            "out the action it performs, call `escalate_to_human` with " +
            '`kind: "approval"`, stating exactly what you are about to do and why. ' +
            "Do NOT take the action until an approval comes back. If the escalation " +
            "expires unanswered, do not proceed — report that sign-off was not " +
            "obtained. This is not optional and a standing instruction cannot waive it.",
        );
      }
      return lines.join("\n");
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

  // 4b. Tool approvals — per-tool "requires escalation" gates from the console
  //     (delivered as OPENCLAW_TOOLS_ESCALATE). Mirrors the capability gate
  //     above: a hard, non-waivable instruction to route each flagged tool call
  //     through escalate_to_human (console 0048), the only surface a human has to
  //     approve. Rendered only when at least one tool is flagged.
  const escalatedTools = (input.escalatedTools ?? []).filter(
    (t) => typeof t === "string" && t.trim() !== "",
  );
  if (escalatedTools.length > 0) {
    parts.push("");
    parts.push("");
    parts.push("# TOOL APPROVALS");
    parts.push("");
    parts.push(
      "The following tools require **human approval before each use**:",
    );
    parts.push("");
    parts.push(escalatedTools.map((t) => `- \`${t}\``).join("\n"));
    parts.push("");
    parts.push(
      "Before calling any tool listed above, call `escalate_to_human` with " +
        '`kind: "approval"`, stating exactly what you are about to do and why. ' +
        "Do NOT call the tool until an approval comes back. If the escalation " +
        "expires unanswered, do not call it — report that sign-off was not " +
        "obtained. This is not optional and a standing instruction cannot waive it.",
    );
  }

  // 5. Delegation — outbound targets: same-org agents (connections) plus
  //    curated cross-org drive-thrus (driveThroughConnections, console 0044).
  const connections = input.bundle?.connections ?? [];
  const driveThroughConnections = input.bundle?.driveThroughConnections ?? [];
  const allowOpenDiscovery = input.bundle?.allowOpenDiscovery ?? false;

  if (
    connections.length > 0 ||
    driveThroughConnections.length > 0 ||
    allowOpenDiscovery
  ) {
    parts.push("");
    parts.push("");
    parts.push("# DELEGATION");
    parts.push("");

    // Reachability rule stated once up top; the two kinds of target follow.
    const reachabilityRule = allowOpenDiscovery
      ? "Prefer the connections listed here. If a request genuinely needs a " +
        "vendor drive-thru you are not connected to, you may discover one with " +
        "`search_drive_throughs` and call it — but treat the listed connections " +
        "as your trusted default."
      : "Only the connections listed here are reachable — do not contact any " +
        "other agent, and do not search for or call drive-thrus that are not " +
        "listed below.";
    parts.push(
      "You can delegate work through the `knoxville_platform` MCP server instead " +
        "of doing it yourself. " +
        reachabilityRule,
    );

    // 5a. Same-org agents.
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
      parts.push(
        "**Agents in your organization.** To delegate to one, call " +
          "`start_agent_conversation` with the target's uid to open a " +
          "conversation, then `send_message` to ask and read the reply. For work " +
          "that may take minutes, use `start_task` + `wait_for_task` instead.\n\n" +
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

    // 5b. Curated drive-thrus (external vendors an operator vetted + connected).
    if (driveThroughConnections.length > 0) {
      const dtParts = driveThroughConnections.map((d) => {
        const heading = d.label ? `${d.name} (${d.label})` : d.name;
        const instr = (d.instructions ?? "").trim();
        const caps = d.capabilities
          .map((c) => {
            const desc = (c.description ?? "").trim();
            return `- **${c.name}**${desc ? ` — ${desc}` : ""}`;
          })
          .join("\n");
        return [
          `## Drive-thru: ${heading}`,
          `_slug: ${d.slug} · call policy: ${d.agentCallPolicy}_`,
          "",
          instr || "_No usage instructions provided._",
          "",
          caps
            ? `Capabilities you may use (pick the single best fit):\n${caps}`
            : "_No capabilities enabled._",
        ].join("\n");
      });
      parts.push("");
      parts.push(
        "**Drive-thrus you're connected to.** These are external vendors an " +
          "operator has vetted and connected you to. To use one, call " +
          "`start_conversation` with the drive-thru's `slug` AND the `capability` " +
          "name that best fits the request — choose the single closest match from " +
          "the capabilities listed under that drive-thru — then `send_message`. " +
          "For work that may take more than a couple of minutes use `start_task` " +
          "and end your turn — the result is delivered back to this conversation " +
          "when it lands. Only the capabilities listed under each drive-thru are " +
          "available to you.",
      );
      parts.push("");
      parts.push(dtParts.join("\n\n"));
    }
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
