import { mkdir, rm } from "node:fs/promises";

import { log } from "../log.js";
import type { AgentBundle, SkillRequirement } from "../bundle/types.js";
import type { InstalledSkill, SkillResolver } from "./resolver.js";

/**
 * Walk every assignment, dedupe its skill requirements, fail loud on
 * conflicting versions, then run them through the resolver. Returns the
 * list of installed skills keyed by ref so the caller can wire prompt
 * assembly + manifest annotations.
 *
 * Reconcile semantics: `workspace/skills/` is wiped (once, by the caller via
 * `resetWorkspaceSkills`) before any installs run, so a skill that was
 * previously installed but is no longer declared by the current bundle OR the
 * console boot list disappears. Those two sources are the desired state; stale
 * installs are a footgun (the LLM still sees them in TOOLS.md).
 */

/** Wipe + recreate the workspace skills dir. Call ONCE per boot before any
 *  installs so bundle + boot-list skills reconcile from a clean slate. */
export async function resetWorkspaceSkills(workspaceSkillsDir: string): Promise<void> {
  await rm(workspaceSkillsDir, { recursive: true, force: true });
  await mkdir(workspaceSkillsDir, { recursive: true });
}

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
  // NOTE: the caller must have already called `resetWorkspaceSkills` — the wipe
  // is shared with the boot-list install so both reconcile from one clean slate.

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

/**
 * Install the console-managed boot list (`config/skills.json`) into the
 * already-reset workspace skills dir. Additive to the bundle install:
 *
 *   - Skips any ref already installed by the bundle (`opts.skip`) so a pinned
 *     bundle version wins over an unpinned boot-list entry, and de-dupes within
 *     the list itself.
 *   - Soft-fails PER SKILL: a bad user-added slug is logged and skipped rather
 *     than crashing the whole boot. This is deliberately gentler than the
 *     bundle install (which fails loud) — the boot list is user-curated via the
 *     console UI, and one typo'd slug must not brick an otherwise-healthy agent.
 */
export async function installBootListSkills(
  requirements: SkillRequirement[],
  workspaceSkillsDir: string,
  resolver: SkillResolver,
  opts: { skip: Set<string> },
): Promise<InstalledSkill[]> {
  const installed: InstalledSkill[] = [];
  const seen = new Set(opts.skip);
  for (const req of requirements) {
    if (seen.has(req.ref)) continue;
    seen.add(req.ref);
    try {
      installed.push(await resolver.install(req, workspaceSkillsDir));
    } catch (err) {
      log.error("boot-list skill install failed (skipped)", {
        ref: req.ref,
        version: req.version || "(latest)",
        err: String(err),
      });
    }
  }
  if (installed.length > 0) {
    log.info("boot-list skills installed", {
      count: installed.length,
      skills: installed.map((s) => (s.version ? `${s.ref}@${s.version}` : s.ref)),
    });
  }
  return installed;
}
