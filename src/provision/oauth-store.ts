import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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

/** Restore a previously-persisted encrypted auth-profile store into the
 *  state dir. Safe to call on every boot — a no-op when nothing is stored.
 *  Returns the number of files written. */
export async function restoreOAuthStore(env: AgentEnv): Promise<number> {
  const payload = await new AgentStorage(env).downloadJSON<PersistedStore>(
    STORAGE_KEY,
  );
  if (!payload?.files) return 0;
  let count = 0;
  for (const [rel, contents] of Object.entries(payload.files)) {
    const abs = join(env.OPENCLAW_STATE_DIR, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents, "utf8");
    count += 1;
  }
  log.info("restored OAuth auth-profile store", {
    files: count,
    saved_at: payload.savedAt,
  });
  return count;
}
