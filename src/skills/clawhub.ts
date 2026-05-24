import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { log } from "../log.js";
import type { SkillRequirement } from "../bundle/types.js";
import type { InstalledSkill, SkillResolver } from "./resolver.js";
import { LocalSkillResolver, SkillNotFoundError } from "./local.js";

/**
 * v1 clawhub resolver. Does NOT call the network yet — it logs a
 * "would install" line, then tries the local resolver as a fallback, and
 * if even that fails it stamps out a placeholder skill.md so openclaw can
 * still boot. Real fetching is a follow-up; the bundle metadata is the
 * source of truth either way.
 */
export class ClawhubSkillResolver implements SkillResolver {
  constructor(private readonly local: LocalSkillResolver) {}

  async install(
    req: SkillRequirement,
    workspaceSkillsDir: string,
  ): Promise<InstalledSkill> {
    log.info("skill resolve (clawhub stub)", {
      ref: req.ref,
      version: req.version,
      integrity: req.integrityHash ?? null,
    });
    try {
      const local = await this.local.install(req, workspaceSkillsDir);
      // Tag the source so boot logs distinguish "really pre-staged" from
      // "we made one up" — even when the local install hits, this code
      // path came through the clawhub resolver.
      return { ...local, source: "clawhub" };
    } catch (err) {
      if (!(err instanceof SkillNotFoundError)) throw err;
      return this.installStub(req, workspaceSkillsDir);
    }
  }

  private async installStub(
    req: SkillRequirement,
    workspaceSkillsDir: string,
  ): Promise<InstalledSkill> {
    const dest = join(workspaceSkillsDir, req.ref);
    await mkdir(dest, { recursive: true });
    const skillMd = [
      `# ${req.ref}`,
      "",
      "_Stub skill placeholder. The real bundle hasn't been fetched yet._",
      "",
      `Pinned version: \`${req.version}\``,
      `Source: \`${req.source}\``,
      "",
      "Until the clawhub resolver is wired up, this skill is documentation-only.",
      "Treat any capability that depends on it as best-effort.",
      "",
    ].join("\n");
    await writeFile(join(dest, "skill.md"), skillMd, "utf8");
    log.warn("skill stubbed (clawhub fetch not implemented)", {
      ref: req.ref,
      version: req.version,
      dest,
    });
    return { ref: req.ref, version: req.version, path: dest, source: "stub" };
  }
}
