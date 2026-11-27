import { createRequire } from "node:module";

/**
 * Same-uid hardening for the long-lived processes that hold secrets: the shim
 * (platform database key, agent token, console gateway token) and the openclaw
 * gateway (the knox plugins' loopback token, delegated credentials in flight).
 *
 * Every process in the container runs as the `agent` uid, including the
 * commands the model starts through the exec tool. On Linux a same-uid process
 * may read another's `/proc/<pid>/environ` and `/proc/<pid>/mem` unless the
 * target is marked non-dumpable — and removing a variable from `process.env`
 * does not help, because `/proc/<pid>/environ` shows the environment the
 * process was STARTED with. So each of these processes calls
 * `prctl(PR_SET_DUMPABLE, 0)` on itself at startup, through the tiny addon
 * built from docker/knox-prctl.c (Node has no binding for it).
 *
 * The kernel resets the flag on every execve, so it never leaks into the exec
 * tool's commands: those stay ordinary, debuggable processes.
 *
 * `noNewPrivs` additionally sets PR_SET_NO_NEW_PRIVS, inherited by every
 * descendant (exec commands included): nothing started below this process can
 * gain privileges through a setuid binary or file capabilities.
 *
 * Best-effort by design: a missing addon (local dev, an image built without
 * the addon stage) or an unsupported platform is reported, never thrown, so a
 * hardening problem can't take an agent down. Callers log the result.
 */

/** Where the Dockerfile installs the addon. */
export const PRCTL_ADDON_PATH = "/opt/knox-prctl/knox_prctl.node";

export interface PrctlAddon {
  setNonDumpable(): number;
  getDumpable(): number;
  setNoNewPrivs(): number;
  getNoNewPrivs(): number;
}

export interface HardeningResult {
  /** True when the process is now non-dumpable. */
  nonDumpable: boolean;
  /** True when no_new_privs is now set (always false unless requested). */
  noNewPrivs: boolean;
  /** Why something could not be applied, when it could not. */
  error?: string;
}

export interface HardeningOptions {
  noNewPrivs?: boolean;
  addonPath?: string;
  /** Injected in tests. */
  loadAddon?: (path: string) => PrctlAddon;
  platform?: NodeJS.Platform;
}

function defaultLoadAddon(path: string): PrctlAddon {
  return createRequire(import.meta.url)(path) as PrctlAddon;
}

export function hardenProcess(opts: HardeningOptions = {}): HardeningResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") {
    return { nonDumpable: false, noNewPrivs: false, error: `unsupported platform ${platform}` };
  }
  let addon: PrctlAddon;
  try {
    addon = (opts.loadAddon ?? defaultLoadAddon)(opts.addonPath ?? PRCTL_ADDON_PATH);
  } catch (err) {
    return {
      nonDumpable: false,
      noNewPrivs: false,
      error: `prctl addon unavailable: ${(err as Error).message ?? String(err)}`,
    };
  }
  const errors: string[] = [];
  let nonDumpable = false;
  let noNewPrivs = false;
  try {
    const rc = addon.setNonDumpable();
    nonDumpable = rc === 0 && addon.getDumpable() === 0;
    if (!nonDumpable) errors.push(`PR_SET_DUMPABLE failed (errno ${rc})`);
  } catch (err) {
    errors.push(`PR_SET_DUMPABLE threw: ${String(err)}`);
  }
  if (opts.noNewPrivs) {
    try {
      const rc = addon.setNoNewPrivs();
      noNewPrivs = rc === 0 && addon.getNoNewPrivs() === 1;
      if (!noNewPrivs) errors.push(`PR_SET_NO_NEW_PRIVS failed (errno ${rc})`);
    } catch (err) {
      errors.push(`PR_SET_NO_NEW_PRIVS threw: ${String(err)}`);
    }
  }
  return errors.length > 0
    ? { nonDumpable, noNewPrivs, error: errors.join("; ") }
    : { nonDumpable, noNewPrivs };
}
