import { mkdir } from "node:fs/promises";

import { log } from "../log.js";
import type { AgentBundle, SkillRequirement } from "../bundle/types.js";
import type { InstalledSkill, SkillResolver } from "./resolver.js";

/**
 * Walk every assignment, dedupe its skill requirements, fail loud on
 * conflicting versions, then run them through the resolver. Returns the
 * list of installed skills keyed by ref so the caller can wire prompt
 * assembly + manifest annotations.
 */

export class SkillVersionConflictError extends Error {
  constructor(
    public readonly ref: string,
    public readonly versions: { version: string; capabilities: string[] }[],
  ) {
    const detail = versions
      .map(
        (v) =>
          `  - ${v.version} required by: ${v.capabilities.join(", ") || "(unknown)"}`,
      )
      .join("\n");
    super(
      `Skill ${ref} requested at conflicting versions:\n${detail}\n` +
        `Resolve in the console (every capability that references ${ref} must pin the same version) and redeploy.`,
    );
    this.name = "SkillVersionConflictError";
  }
}

export async function installBundleSkills(
  bundle: AgentBundle,
  workspaceSkillsDir: string,
  resolver: SkillResolver,
): Promise<InstalledSkill[]> {
  await mkdir(workspaceSkillsDir, { recursive: true });

  // 1. Collect every (ref, version) pair, keyed by ref. Two different
  //    versions of the same ref is a fatal config error.
  type Pending = {
    req: SkillRequirement;
    versionsToCapabilities: Map<string, string[]>;
  };
  const byRef = new Map<string, Pending>();
  for (const a of bundle.assignments) {
    const skill = a.capability.skill;
    if (!skill) continue;
    const slot = byRef.get(skill.ref);
    const capLabel = `${a.listing.slug}#${a.capability.id ?? a.capability.name}`;
    if (!slot) {
      byRef.set(skill.ref, {
        req: skill,
        versionsToCapabilities: new Map([[skill.version, [capLabel]]]),
      });
      continue;
    }
    const existing = slot.versionsToCapabilities.get(skill.version);
    if (existing) {
      existing.push(capLabel);
    } else {
      slot.versionsToCapabilities.set(skill.version, [capLabel]);
    }
  }

  for (const [ref, pending] of byRef) {
    if (pending.versionsToCapabilities.size === 1) continue;
    const versions = [...pending.versionsToCapabilities.entries()].map(
      ([version, capabilities]) => ({ version, capabilities }),
    );
    throw new SkillVersionConflictError(ref, versions);
  }

  // 2. Install in stable ref order so logs are deterministic.
  const installed: InstalledSkill[] = [];
  const refs = [...byRef.keys()].sort();
  for (const ref of refs) {
    const { req } = byRef.get(ref)!;
    const result = await resolver.install(req, workspaceSkillsDir);
    installed.push(result);
  }
  log.info("skills installed", {
    count: installed.length,
    skills: installed.map((s) => `${s.ref}@${s.version} (${s.source})`),
  });
  return installed;
}
