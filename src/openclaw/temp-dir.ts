import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { log } from "../log.js";

/**
 * Give openclaw a private, agent-owned temp directory and return it so
 * callers can pass it as `TMPDIR` in the spawn env.
 *
 * Why this exists — the `Unsafe fallback OpenClaw temp dir` crash:
 *
 *   openclaw resolves a temp dir at startup (see its
 *   `resolvePreferredOpenClawTmpDir`). On POSIX it first tries the
 *   *shared, hardcoded* path `/tmp/openclaw`; if that isn't usable by the
 *   current uid it falls back to `${os.tmpdir()}/openclaw-<uid>`
 *   (e.g. `/tmp/openclaw-1001`). If that fallback dir already exists but
 *   isn't owned by our uid — or is group/world-writable — and can't be
 *   repaired, openclaw THROWS `Unsafe fallback OpenClaw temp dir: …` and
 *   aborts before doing anything. `openclaw skills install` then "won't
 *   start". Both `/tmp/openclaw` and `/tmp/openclaw-<uid>` are predictable
 *   paths in a world-writable, sticky `/tmp`, so one stray dir left by
 *   another uid (or an earlier openclaw version with looser perms) poisons
 *   every subsequent openclaw command.
 *
 *   `os.tmpdir()` honors `$TMPDIR` on POSIX, and it governs exactly that
 *   fallback path. By pointing `TMPDIR` at a directory under our own state
 *   dir — which lives in the agent's home, is owned by the agent uid, and
 *   is mode 0700 — openclaw's fallback lands somewhere we fully control
 *   instead of the contended `/tmp` path, and the unsafe-fallback check
 *   passes. The hardcoded `/tmp/openclaw` preference is unaffected; it's
 *   only consulted first and only the fallback was ever failing.
 *
 * Idempotent: safe to call on every spawn. We re-chmod to 0700 so a dir
 * that survived on a persistent volume with loosened perms is tightened
 * back to something openclaw will accept.
 */
export function ensureOpenclawTempDir(stateDir: string): string {
  const tempDir = join(stateDir, "tmp");
  try {
    mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by umask and a no-op when the dir already
    // exists, so set it explicitly to guarantee openclaw sees 0700.
    chmodSync(tempDir, 0o700);
  } catch (err) {
    // Don't abort boot over this: if the dir can't be prepared, openclaw
    // falls back to its own resolution (and surfaces the original error).
    log.warn("failed to prepare openclaw temp dir", {
      tempDir,
      err: String(err),
    });
  }
  return tempDir;
}
