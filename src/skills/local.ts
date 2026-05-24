import { access, cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { log } from "../log.js";
import type { SkillRequirement } from "../bundle/types.js";
import type { InstalledSkill, SkillResolver } from "./resolver.js";

/**
 * Resolves a skill from a local pre-staged directory. The image (or a
 * future Storage pull step) places skill bundles under `SKILLS_DIR/<ref>`
 * (with an optional `<ref>@<version>` directory taking precedence so two
 * versions can co-exist on disk). The resolver copies the matched
 * directory into `workspace/skills/<ref>/` for openclaw to pick up.
 *
 * If neither directory exists, throws — the caller decides whether to
 * tolerate that (the clawhub resolver wraps this and falls back to a
 * stub install instead).
 */
export class LocalSkillResolver implements SkillResolver {
  constructor(private readonly skillsSourceDir: string) {}

  async install(
    req: SkillRequirement,
    workspaceSkillsDir: string,
  ): Promise<InstalledSkill> {
    const versionedSrc = join(this.skillsSourceDir, `${req.ref}@${req.version}`);
    const refSrc = join(this.skillsSourceDir, req.ref);
    const src = (await exists(versionedSrc))
      ? versionedSrc
      : (await exists(refSrc))
        ? refSrc
        : null;
    if (!src) {
      throw new SkillNotFoundError(req, [versionedSrc, refSrc]);
    }
    const dest = join(workspaceSkillsDir, req.ref);
    await mkdir(workspaceSkillsDir, { recursive: true });
    await cp(src, dest, { recursive: true, force: true });
    log.info("skill installed (local)", {
      ref: req.ref,
      version: req.version,
      src,
      dest,
    });
    return { ref: req.ref, version: req.version, path: dest, source: "local" };
  }
}

export class SkillNotFoundError extends Error {
  constructor(public readonly req: SkillRequirement, public readonly tried: string[]) {
    super(
      `skill ${req.ref}@${req.version} not found locally (tried: ${tried.join(", ")})`,
    );
    this.name = "SkillNotFoundError";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
