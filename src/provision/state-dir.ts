import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { log } from "../log.js";

/**
 * Fail loud if the agent cannot write to OPENCLAW_STATE_DIR.
 *
 * On Railway this dir is a mounted volume. The volume is mounted root-owned
 * and empty; the container entrypoint chowns it to the agent uid before
 * dropping privileges (see entrypoint.sh + Dockerfile). If that handoff ever
 * regresses — a volume that the process can't write to — openclaw would boot,
 * silently fail to persist sessions/memory, and the agent would lose all
 * continuity without any obvious signal. That is worse than no volume at all.
 *
 * So we probe writability at boot and THROW on failure: a non-writable state
 * dir is a fatal misconfiguration, not something to log-and-continue past.
 * Unlike the non-fatal manifest/oauth restore steps, this aborts the boot.
 */
export function assertStateDirWritable(stateDir: string): void {
  const probe = join(stateDir, ".knox-write-check");
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(probe, `${new Date().toISOString()}\n`, "utf8");
    unlinkSync(probe);
  } catch (err) {
    throw new Error(
      `OPENCLAW_STATE_DIR is not writable (${stateDir}): ${String(err)}. ` +
        `On Railway this is the persistence volume — check the entrypoint ` +
        `chown/gosu handoff and the volume mount.`,
    );
  }
  log.info("state dir writable", { stateDir });
}
