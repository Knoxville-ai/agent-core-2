import type { SkillRequirement } from "../bundle/types.js";

/**
 * Interface for installing a skill bundle into the openclaw workspace.
 * v1 has two implementations:
 *   - LocalSkillResolver: looks under SKILLS_DIR for a pre-staged copy.
 *   - ClawhubSkillResolver: stub that logs "would install" and falls
 *     through to the local resolver. Real clawhub fetch is a follow-up.
 */

export interface InstalledSkill {
  ref: string;
  version: string;
  /** Absolute path inside `workspace/skills/` where the skill ended up. */
  path: string;
  source: "local" | "clawhub" | "stub";
}

export interface SkillResolver {
  install(
    req: SkillRequirement,
    workspaceSkillsDir: string,
  ): Promise<InstalledSkill>;
}
