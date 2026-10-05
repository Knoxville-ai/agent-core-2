import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { log } from "../log.js";
import { isSha256, isValidSkillSlug, sha256Hex, type ManifestEntry } from "./contract.js";

/**
 * The vessel's record of what SkillSync put in `workspace/skills/`:
 * `$OPENCLAW_STATE_DIR/platform-skills.lock.json` on the volume.
 *
 * It is the reconciler's memory between runs and boots: which slug is at which
 * content digest (so a boot installs only what changed and a platform outage
 * keeps the last-known-good set), the plan generation last fully applied (the
 * poll's cheap `if_generation` no-op), the deps hash per skill (an update that
 * doesn't touch `install.uv` skips `uv`), and each installed skill's manifest
 * (so the blob cache can be garbage-collected and a half-finished swap can be
 * detected by re-hashing on boot).
 *
 * Written atomically (tmp + fsync + rename), and only AFTER the folder swap it
 * describes: a crash between the two leaves a folder newer than the lock, which
 * the boot verification re-hashes, notices and repairs.
 */

export const LOCK_FILE = "platform-skills.lock.json";

export type LockedSkillSource = "library" | "clawhub";

export interface LockedSkill {
  /** Library ids (null for a legacy ClawHub install). */
  skill_id: string | null;
  version_id: string | null;
  version: string | null;
  /** The manifest digest; `clawhub:<version|latest>` for a legacy install. */
  content_sha256: string;
  /** `metadata.openclaw.skillKey` when set — the openclaw.json entry key. */
  skill_key: string | null;
  managed_by: string;
  required: boolean;
  source: LockedSkillSource;
  /** See deps.ts `depsHash` (null: no `install.uv`, or not provisioned). */
  deps_hash: string | null;
  installed_at: string;
  /** The installed manifest (library skills only): blob GC + boot re-hash. */
  files?: ManifestEntry[];
}

export interface SkillLock {
  version: 1;
  /** The last plan generation fully applied (0 = never). */
  generation: number;
  skills: Record<string, LockedSkill>;
}

export function emptyLock(): SkillLock {
  return { version: 1, generation: 0, skills: {} };
}

export function lockPath(stateDir: string): string {
  return join(stateDir, LOCK_FILE);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function parseFiles(v: unknown): ManifestEntry[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ManifestEntry[] = [];
  for (const f of v) {
    if (!isRecord(f)) continue;
    if (typeof f.path !== "string" || typeof f.sha256 !== "string") continue;
    if (typeof f.size !== "number") continue;
    out.push({ path: f.path, sha256: f.sha256, size: f.size, executable: f.executable === true });
  }
  return out;
}

/** Validate a parsed lock document, dropping malformed entries. Pure. */
export function parseLock(raw: unknown): SkillLock {
  const lock = emptyLock();
  if (!isRecord(raw)) return lock;
  if (typeof raw.generation === "number" && Number.isFinite(raw.generation) && raw.generation >= 0) {
    lock.generation = Math.floor(raw.generation);
  }
  if (!isRecord(raw.skills)) return lock;
  for (const [slug, e] of Object.entries(raw.skills)) {
    // A slug becomes a path under workspace/skills — never trust one that
    // isn't a valid skill slug, even from our own file.
    if (!isValidSkillSlug(slug) || !isRecord(e)) continue;
    const content = str(e.content_sha256);
    if (!content) continue;
    const source: LockedSkillSource = e.source === "clawhub" ? "clawhub" : "library";
    const entry: LockedSkill = {
      skill_id: str(e.skill_id),
      version_id: str(e.version_id),
      version: str(e.version),
      content_sha256: content,
      skill_key: str(e.skill_key),
      managed_by: str(e.managed_by) ?? "operator",
      required: e.required === true,
      source,
      deps_hash: str(e.deps_hash),
      installed_at: str(e.installed_at) ?? new Date(0).toISOString(),
    };
    const files = parseFiles(e.files);
    if (files) entry.files = files;
    lock.skills[slug] = entry;
  }
  return lock;
}

export interface LoadedLock {
  lock: SkillLock;
  /** False when no lock file existed (this vessel never ran library mode, or
   *  legacy mode cleared it) or it was unreadable. */
  existed: boolean;
}

/** Read the lock. Missing → empty (existed: false). Corrupt → empty, logged. */
export async function readLock(stateDir: string): Promise<LoadedLock> {
  let text: string;
  try {
    text = await readFile(lockPath(stateDir), "utf8");
  } catch {
    return { lock: emptyLock(), existed: false };
  }
  try {
    return { lock: parseLock(JSON.parse(text)), existed: true };
  } catch (err) {
    log.warn("skill lock unreadable; treating as empty", { err: String(err) });
    return { lock: emptyLock(), existed: false };
  }
}

/** Serialize with stable key order (slugs sorted) so rewrites of an unchanged
 *  lock are byte-identical. */
export function serializeLock(lock: SkillLock): string {
  const skills: Record<string, LockedSkill> = {};
  for (const slug of Object.keys(lock.skills).sort()) skills[slug] = lock.skills[slug]!;
  return `${JSON.stringify({ version: 1, generation: lock.generation, skills }, null, 2)}\n`;
}

/** Write `text` to `path` atomically: tmp file in the same dir, fsync, rename. */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fh = await open(tmp, "wx", 0o644);
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function writeLock(stateDir: string, lock: SkillLock): Promise<void> {
  await writeFileAtomic(lockPath(stateDir), serializeLock(lock));
}

/** Remove the lock (legacy mode: the folders no longer match it). */
export async function clearLock(stateDir: string): Promise<void> {
  await rm(lockPath(stateDir), { force: true });
}

/**
 * The digest of what the vessel is running: sha256 over the lock's
 * `slug@content_sha256` lines, sorted byte-wise and joined by "\n" (every
 * entry, library and legacy). An empty lock digests the empty string.
 */
export function lockDigest(lock: SkillLock): string {
  const lines = Object.entries(lock.skills).map(([slug, e]) => `${slug}@${e.content_sha256}`);
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(lines.join("\n"));
}

/** The `skills.entries.<key>.config.rev` value for a content digest: its first
 *  12 hex chars (a non-hex legacy marker like `clawhub:1.2.0` is hashed first). */
export function revFor(contentSha256: string): string {
  return (isSha256(contentSha256) ? contentSha256 : sha256Hex(contentSha256)).slice(0, 12);
}

/** The openclaw.json `skills.entries` key for a locked skill. */
export function entryKeyFor(slug: string, entry: Pick<LockedSkill, "skill_key">): string {
  return entry.skill_key || slug;
}

export type SkillEntries = Record<string, { config: { rev: string } }>;

/**
 * The `skills.entries` block the boot config emits for the lock: one
 * `{ config: { rev } }` per installed skill, keys sorted. The same values the
 * live refresh writes, so a boot-time config already carries every rev.
 */
export function lockSkillEntries(lock: SkillLock): SkillEntries {
  const pairs: Array<[string, string]> = Object.entries(lock.skills).map(([slug, e]) => [
    entryKeyFor(slug, e),
    revFor(e.content_sha256),
  ]);
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: SkillEntries = {};
  for (const [key, rev] of pairs) out[key] = { config: { rev } };
  return out;
}

/** Read the lock and derive its entries (empty when there is no lock). */
export async function readLockSkillEntries(stateDir: string): Promise<SkillEntries> {
  return lockSkillEntries((await readLock(stateDir)).lock);
}
