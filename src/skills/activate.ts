import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { log } from "../log.js";
import { isSafeSkillPath, sha256Hex, type ManifestEntry } from "./contract.js";
import { parseFrontmatter } from "./deps.js";

/**
 * Folder operations behind SkillSync. Everything happens inside the workspace
 * (`$OPENCLAW_STATE_DIR/workspace`, one filesystem) so every swap is a rename:
 *
 *   workspace/skills/<slug>                live — the only place OpenClaw looks
 *   workspace/.skills-staging/<slug>-<sha8> a version being written + checked
 *   workspace/.skills-trash/<slug>-<ts>     the version just replaced/removed
 *   workspace/.skills-unmanaged/<slug>-<ts> folders no plan put there (kept)
 *
 * Presence under `skills/` is the ONLY visibility control the pinned OpenClaw
 * honors live, so "staged", "removed" and "quarantined" all mean "moved out of
 * skills/".
 */

/** Thrown for a version that can never install as published (unsafe path,
 *  missing SKILL.md, name ≠ slug, …). Retrying the same plan won't help. */
export class SkillContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillContentError";
  }
}

export interface WorkspaceDirs {
  workspace: string;
  skills: string;
  staging: string;
  trash: string;
  unmanaged: string;
}

export function workspaceDirs(stateDir: string): WorkspaceDirs {
  const workspace = join(stateDir, "workspace");
  return {
    workspace,
    skills: join(workspace, "skills"),
    staging: join(workspace, ".skills-staging"),
    trash: join(workspace, ".skills-trash"),
    unmanaged: join(workspace, ".skills-unmanaged"),
  };
}

/** A collision-proof suffix for trash/quarantine names. */
function stamp(): string {
  return `${Date.now()}-${randomBytes(3).toString("hex")}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Source of a file body during materialization (the blob cache in prod). */
export interface BlobSource {
  read(sha256: string): Promise<Buffer>;
}

/**
 * Write a manifest's files into a FRESH directory `dest`. Every path must pass
 * `isSafeSkillPath` (and is re-checked to resolve inside `dest`); every body is
 * hash-checked against the manifest; every file is a new regular file opened
 * with O_EXCL (`wx` — nothing pre-existing is followed or overwritten) and set
 * to exactly 0755 when executable, else 0644. Throws SkillContentError for a
 * manifest that can't be materialized as published.
 */
export async function materialize(
  files: ManifestEntry[],
  dest: string,
  blobs: BlobSource,
): Promise<void> {
  for (const f of files) {
    if (!isSafeSkillPath(f.path)) {
      throw new SkillContentError(`unsafe path in manifest: ${JSON.stringify(f.path)}`);
    }
  }
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  const root = resolve(dest);
  for (const f of files) {
    const target = resolve(root, f.path);
    if (!target.startsWith(root + sep)) {
      throw new SkillContentError(`path escapes the skill folder: ${JSON.stringify(f.path)}`);
    }
    const bytes = await blobs.read(f.sha256);
    if (bytes.length !== f.size || sha256Hex(bytes) !== f.sha256) {
      throw new SkillContentError(`content for ${f.path} does not match its manifest entry`);
    }
    const mode = f.executable ? 0o755 : 0o644;
    try {
      await mkdir(dirname(target), { recursive: true });
      const fh = await open(target, "wx", mode);
      try {
        await fh.writeFile(bytes);
      } finally {
        await fh.close();
      }
      // open()'s mode is masked by the umask; set it exactly.
      await chmod(target, mode);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTDIR" || code === "EISDIR") {
        throw new SkillContentError(`manifest paths collide at ${f.path}`);
      }
      throw err;
    }
  }
}

export interface StagedSkill {
  frontmatter: Record<string, unknown>;
}

/** A staged skill must have `SKILL.md` at its root whose frontmatter `name` is
 *  the slug (parsed leniently, like OpenClaw does). Nothing else is checked —
 *  description length in particular is never a reason to refuse a skill. */
export async function validateStagedSkill(dir: string, slug: string): Promise<StagedSkill> {
  let md: string;
  try {
    md = await readFile(join(dir, "SKILL.md"), "utf8");
  } catch {
    throw new SkillContentError("SKILL.md is missing from the skill root");
  }
  const frontmatter = parseFrontmatter(md);
  if (!frontmatter) {
    throw new SkillContentError("SKILL.md has no readable frontmatter");
  }
  const name = frontmatter.name;
  const nameStr = typeof name === "string" || typeof name === "number" ? String(name).trim() : "";
  if (nameStr !== slug) {
    throw new SkillContentError(
      `SKILL.md frontmatter name ${JSON.stringify(nameStr)} does not match the slug ${JSON.stringify(slug)}`,
    );
  }
  return { frontmatter };
}

/** Where a staged version of `slug` is written. */
export function stagingDirFor(dirs: WorkspaceDirs, slug: string, contentSha256: string): string {
  return join(dirs.staging, `${slug}-${contentSha256.slice(0, 8)}`);
}

export interface SwapResult {
  /** A previous folder was replaced. */
  replaced: boolean;
  /** Set when the previous folder wasn't ours and was quarantined instead of
   *  deleted: its quarantine path. */
  quarantinedTo?: string;
}

/**
 * Atomically activate `staged` as `skills/<slug>`: the current folder (if any)
 * is renamed out of the way, the staged folder renamed in, then the old copy
 * deleted — or, when `preserveExisting`, kept in `.skills-unmanaged/` (a folder
 * the platform didn't put there is never destroyed). On a failed rename-in the
 * old folder is put back.
 */
export async function swapIntoPlace(
  dirs: WorkspaceDirs,
  slug: string,
  staged: string,
  opts: { preserveExisting?: boolean } = {},
): Promise<SwapResult> {
  const live = join(dirs.skills, slug);
  await mkdir(dirs.skills, { recursive: true });
  let moved: string | null = null;
  if (await exists(live)) {
    const parking = opts.preserveExisting ? dirs.unmanaged : dirs.trash;
    await mkdir(parking, { recursive: true });
    moved = join(parking, `${slug}-${stamp()}`);
    await rename(live, moved);
  }
  try {
    await rename(staged, live);
  } catch (err) {
    if (moved) await rename(moved, live).catch(() => {});
    throw err;
  }
  if (moved && !opts.preserveExisting) {
    await rm(moved, { recursive: true, force: true }).catch((err) => {
      log.warn("skill trash cleanup failed", { path: moved, err: String(err) });
    });
  }
  return {
    replaced: moved !== null,
    ...(moved && opts.preserveExisting ? { quarantinedTo: moved } : {}),
  };
}

/** Take `skills/<slug>` out of service (rename to trash, then delete). */
export async function removeSkillDir(dirs: WorkspaceDirs, slug: string): Promise<boolean> {
  const live = join(dirs.skills, slug);
  if (!(await exists(live))) return false;
  await mkdir(dirs.trash, { recursive: true });
  const moved = join(dirs.trash, `${slug}-${stamp()}`);
  await rename(live, moved);
  await rm(moved, { recursive: true, force: true }).catch((err) => {
    log.warn("skill trash cleanup failed", { path: moved, err: String(err) });
  });
  return true;
}

/** Move `skills/<name>` to `.skills-unmanaged/<name>-<ts>` (kept, not deleted). */
export async function quarantineSkillDir(dirs: WorkspaceDirs, name: string): Promise<string> {
  await mkdir(dirs.unmanaged, { recursive: true });
  const dest = join(dirs.unmanaged, `${name}-${stamp()}`);
  await rename(join(dirs.skills, name), dest);
  return dest;
}

/** Every non-hidden directory (or symlink) directly under `skills/`. */
export async function listSkillDirs(dirs: WorkspaceDirs): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dirs.skills, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()))
    .map((e) => e.name)
    .sort();
}

/** Does `skills/<slug>/SKILL.md` exist (cheap liveness check)? */
export async function skillMdPresent(dirs: WorkspaceDirs, slug: string): Promise<boolean> {
  try {
    return (await lstat(join(dirs.skills, slug, "SKILL.md"))).isFile();
  } catch {
    return false;
  }
}

/**
 * Re-hash a live skill folder against its manifest: every manifest file must be
 * present with the recorded size and sha256. Extra files (e.g. `__pycache__`
 * from running the skill's scripts) are fine. False on any mismatch — a
 * half-finished swap or a hand edit — so the caller re-installs it.
 */
export async function verifySkillDir(
  dirs: WorkspaceDirs,
  slug: string,
  files: ManifestEntry[],
): Promise<boolean> {
  const root = join(dirs.skills, slug);
  for (const f of files) {
    if (!isSafeSkillPath(f.path)) return false;
    try {
      const st = await lstat(join(root, f.path));
      if (!st.isFile() || st.size !== f.size) return false;
      const bytes = await readFile(join(root, f.path));
      if (sha256Hex(bytes) !== f.sha256) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Clear leftovers of interrupted runs (staging + trash). Never throws. */
export async function sweepScratchDirs(dirs: WorkspaceDirs): Promise<void> {
  await rm(dirs.staging, { recursive: true, force: true }).catch(() => {});
  await rm(dirs.trash, { recursive: true, force: true }).catch(() => {});
}
