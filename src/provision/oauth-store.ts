import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { AgentStorage } from "./supabase-storage.js";

/**
 * Persistence for OpenClaw's OAuth auth-profile store.
 *
 * The container filesystem is ephemeral and any model change redeploys it,
 * which would wipe an OAuth token minted on the running container. To make
 * OAuth survive redeploys we:
 *
 *   1. set OPENCLAW_AUTH_PROFILE_SECRET_KEY (a stable per-agent secret) so
 *      OpenClaw's encrypted store is decryptable on ANY future container —
 *      the encryption key is sha256("openclaw:auth-profile-oauth:" + seed);
 *   2. after a successful OAuth mint, upload the encrypted store files here;
 *   3. restore them into the state dir on every boot, BEFORE the gateway
 *      starts, so OpenClaw reads back the same (decryptable) token.
 *
 * We only ever move OpenClaw's already-encrypted bytes — no plaintext token
 * touches Supabase. Without the matching seed the persisted blob is useless.
 */

const STORAGE_KEY = "config/oauth/auth-profile-store.json";

// File basenames under the state dir that hold OpenClaw auth material. The
// active token store is the encrypted auth-profiles.json under each agent
// dir; auth.json is a legacy compat file; credentials/oauth.json is the
// legacy import sidecar. We capture all so a restore is faithful.
const AUTH_FILE_NAMES = new Set([
  "auth-profiles.json",
  "auth.json",
  "oauth.json",
]);

// Subtrees of the state dir to scan. `agents/` holds the per-agent stores;
// `credentials/` holds the legacy oauth sidecar.
const SCAN_ROOTS = ["agents", "credentials"];

/** One path segment of a restorable entry (never `.` or `..`). */
const SEGMENT_RE = /^[A-Za-z0-9._@+-]{1,128}$/;
/** Deepest restorable entry, counting the root and the file name. */
const MAX_ENTRY_DEPTH = 8;
const MAX_ENTRY_PATH_CHARS = 512;
/** Auth stores are a few KB; anything far larger is not one. */
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;

interface PersistedStore {
  version: 1;
  savedAt: string;
  /** state-dir-relative path -> raw (encrypted) file contents. */
  files: Record<string, string>;
}

async function collectAuthFiles(
  stateDir: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const root of SCAN_ROOTS) {
    const base = join(stateDir, root);
    let entries: string[];
    try {
      entries = (await readdir(base, { recursive: true })) as string[];
    } catch {
      continue; // root doesn't exist yet
    }
    for (const rel of entries) {
      const name = rel.split(/[\\/]/).pop() ?? "";
      if (!AUTH_FILE_NAMES.has(name)) continue;
      const abs = join(base, rel);
      try {
        // Regular files only: never capture what a symlink points at.
        if (!(await lstat(abs)).isFile()) continue;
        out[join(root, rel)] = await readFile(abs, "utf8");
      } catch {
        // directory entry or unreadable file — skip
      }
    }
  }
  return out;
}

/** Upload the current encrypted auth-profile store to Storage. Call after a
 *  successful OAuth mint. Returns the number of files captured. */
export async function persistOAuthStore(env: AgentEnv): Promise<number> {
  const files = await collectAuthFiles(env.OPENCLAW_STATE_DIR);
  const count = Object.keys(files).length;
  if (count === 0) {
    log.warn("persistOAuthStore: no auth-profile files found to persist");
    return 0;
  }
  const payload: PersistedStore = {
    version: 1,
    savedAt: new Date().toISOString(),
    files,
  };
  await new AgentStorage(env).uploadJSON(STORAGE_KEY, payload);
  log.info("persisted OAuth auth-profile store", { files: count });
  return count;
}

/**
 * The absolute target for a stored entry, or null when the entry is not one
 * this module could have persisted: a relative POSIX path under one of
 * SCAN_ROOTS, every segment `[A-Za-z0-9._@+-]` (never `.`/`..`), at most
 * MAX_ENTRY_DEPTH deep, ending in one of AUTH_FILE_NAMES, and resolving inside
 * `<stateDir>/<root>/`. Pure — symlinks are checked when writing.
 */
export function oauthStoreTarget(stateDir: string, rel: unknown): string | null {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > MAX_ENTRY_PATH_CHARS) return null;
  if (rel.startsWith("/") || rel.includes("\\") || rel.includes("\0")) return null;
  const segments = rel.split("/");
  if (segments.length < 2 || segments.length > MAX_ENTRY_DEPTH) return null;
  if (!segments.every((s) => s !== "." && s !== ".." && SEGMENT_RE.test(s))) return null;
  if (!SCAN_ROOTS.includes(segments[0]!)) return null;
  if (!AUTH_FILE_NAMES.has(segments[segments.length - 1]!)) return null;
  const rootDir = resolve(stateDir, segments[0]!);
  const abs = resolve(stateDir, rel);
  if (!abs.startsWith(rootDir + sep)) return null;
  return abs;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Write one validated entry without following a symlink anywhere below the
 * state dir: every intermediate directory must be a real directory (missing
 * ones are created one level at a time), the parent's realpath must stay
 * inside the state dir's realpath, and the file itself is opened O_NOFOLLOW.
 * Returns false (nothing written) when any check fails.
 */
async function writeEntry(stateDir: string, rel: string, contents: string): Promise<boolean> {
  const root = resolve(stateDir);
  await mkdir(root, { recursive: true });
  const segments = rel.split("/");
  let dir = root;
  for (const segment of segments.slice(0, -1)) {
    dir = join(dir, segment);
    let st;
    try {
      st = await lstat(dir);
    } catch (err) {
      if (!isEnoent(err)) throw err;
      try {
        await mkdir(dir, { mode: 0o700 });
      } catch (mkErr) {
        if ((mkErr as NodeJS.ErrnoException).code !== "EEXIST") throw mkErr;
      }
      st = await lstat(dir);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  const realRoot = await realpath(root);
  const realDir = await realpath(dir);
  if (!realDir.startsWith(realRoot + sep)) return false;
  const target = join(dir, segments[segments.length - 1]!);
  try {
    if (!(await lstat(target)).isFile()) return false;
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  await writeFile(target, contents, {
    encoding: "utf8",
    mode: 0o600,
    flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
  });
  return true;
}

/** Restore a previously-persisted encrypted auth-profile store into the
 *  state dir. Safe to call on every boot — a no-op when nothing is stored.
 *  Only entries that pass `oauthStoreTarget` and the no-symlink write checks
 *  are written; the rest are skipped and logged. Returns the number of files
 *  written. */
export async function restoreOAuthStore(env: AgentEnv): Promise<number> {
  const payload = await new AgentStorage(env).downloadJSON<PersistedStore>(
    STORAGE_KEY,
  );
  const files: unknown = payload?.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) return 0;
  let count = 0;
  const refused: string[] = [];
  for (const [rel, contents] of Object.entries(files as Record<string, unknown>)) {
    const target = oauthStoreTarget(env.OPENCLAW_STATE_DIR, rel);
    if (
      !target ||
      typeof contents !== "string" ||
      Buffer.byteLength(contents, "utf8") > MAX_ENTRY_BYTES
    ) {
      refused.push(rel.slice(0, 120));
      continue;
    }
    try {
      if (await writeEntry(env.OPENCLAW_STATE_DIR, rel, contents)) {
        count += 1;
      } else {
        refused.push(rel.slice(0, 120));
      }
    } catch (err) {
      log.warn("oauth store restore: entry not written", { path: rel.slice(0, 120), err: String(err) });
    }
  }
  if (refused.length > 0) {
    log.warn("oauth store restore: skipped entries outside the auth-store layout", { paths: refused });
  }
  log.info("restored OAuth auth-profile store", {
    files: count,
    skipped: refused.length,
    saved_at: payload?.savedAt,
  });
  return count;
}
