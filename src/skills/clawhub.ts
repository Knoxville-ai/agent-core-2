import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { log } from "../log.js";
import type { SkillRequirement } from "../bundle/types.js";
import { childEnv } from "../openclaw/child-env.js";
import { ensureOpenclawTempDir } from "../openclaw/temp-dir.js";
import { clawhubIntegrityMode, verifyClawhubInstall, type ClawhubIntegrityMode } from "./clawhub-integrity.js";
import type { InstalledSkill, SkillResolver } from "./resolver.js";

/**
 * Real clawhub resolver — shells out to `openclaw skills install` so the
 * gateway's own installer fetches, verifies, and unpacks the skill into
 * the workspace's `skills/` directory. We re-run on every boot with
 * `--force` so a console-side bundle edit takes effect the moment the
 * agent restarts.
 *
 * Fails loud: any non-zero exit, missing binary, or version-mismatch
 * after install aborts the boot — same posture as missing credentials.
 * The local pre-staged resolver in ./local.ts is no longer chained in
 * here; it stays around for dev workflows but doesn't paper over a
 * clawhub outage in production.
 *
 * Every install is content-checked before it is returned (./clawhub-integrity.ts):
 * the folder's manifest digest must match the requirement's `integrityHash`
 * when one is given, and otherwise the trust-on-first-use pin for that slug and
 * version (or, with CLAWHUB_INTEGRITY=require, an unhashed install is refused).
 * A refused install's folder is removed before the error propagates.
 */

const INSTALL_TIMEOUT_MS = 120_000;
const CLAWHUB_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

export interface ClawhubResolverOptions {
  /** Mirrors the env we hand to the gateway in `openclaw/gateway-process.ts`
   *  — HOME + OPENCLAW_HOME must be the *parent* of the state dir so
   *  the CLI's clawhub subprocess derives `<userHome>/.openclaw` paths
   *  the same way the gateway does. */
  stateDir: string;
  /** Binary name or absolute path. Defaults to `openclaw` on PATH. */
  binary?: string;
  /** Default: from CLAWHUB_INTEGRITY (see clawhub-integrity.ts). */
  integrityMode?: ClawhubIntegrityMode;
}

export class ClawhubSkillResolver implements SkillResolver {
  private readonly stateDir: string;
  private readonly binary: string;
  private readonly integrityMode: ClawhubIntegrityMode;

  constructor(opts: ClawhubResolverOptions) {
    this.stateDir = opts.stateDir;
    this.binary = opts.binary ?? "openclaw";
    this.integrityMode = opts.integrityMode ?? clawhubIntegrityMode();
  }

  async install(
    req: SkillRequirement,
    workspaceSkillsDir: string,
  ): Promise<InstalledSkill> {
    if (req.source !== "clawhub") {
      throw new Error(
        `ClawhubSkillResolver only handles source=clawhub; got "${req.source}" for ${req.ref}@${req.version}`,
      );
    }
    // The same slug rule `openclaw skills install` applies; checked here too
    // because the folder path below is derived from it.
    if (!CLAWHUB_SLUG_RE.test(req.ref)) {
      throw new Error(`invalid clawhub skill slug: ${JSON.stringify(req.ref.slice(0, 80))}`);
    }
    const args = ["skills", "install", req.ref];
    // Pin the version when the requirement carries one (bundle skills always
    // do). The console boot list (config/skills.json) may leave it unset, in
    // which case we install the latest — `openclaw skills install <slug>`.
    if (req.version) {
      args.push("--version", req.version);
    }
    // Force a re-fetch so the boot-time install always matches the pinned
    // version, even when a previous boot left a stale copy on disk (Railway
    // volumes survive container restarts).
    args.push("--force");
    await this.run(args, req);
    const dest = join(workspaceSkillsDir, req.ref);
    let verdict;
    try {
      verdict = await verifyClawhubInstall({
        req,
        dir: dest,
        stateDir: this.stateDir,
        mode: this.integrityMode,
      });
    } catch (err) {
      await rm(dest, { recursive: true, force: true }).catch(() => undefined);
      log.error("clawhub skill refused by the integrity check (folder removed)", {
        ref: req.ref,
        version: req.version || "(latest)",
        err: String(err),
      });
      throw err;
    }
    log.info("skill installed (clawhub)", {
      ref: req.ref,
      version: req.version,
      dest,
      digest: verdict.digest,
      integrity: verdict.basis,
    });
    return {
      ref: req.ref,
      version: req.version,
      path: dest,
      source: "clawhub",
    };
  }

  private async run(args: string[], req: SkillRequirement): Promise<void> {
    const userHome = dirname(this.stateDir);
    // Redirect openclaw's temp-dir fallback to a private agent-owned dir so
    // the install doesn't crash with "Unsafe fallback OpenClaw temp dir" on
    // a contended /tmp. See ../openclaw/temp-dir.ts.
    const tempDir = ensureOpenclawTempDir(this.stateDir);
    return await new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        env: childEnv({
          HOME: userHome,
          OPENCLAW_HOME: userHome,
          OPENCLAW_STATE_DIR: this.stateDir,
          TMPDIR: tempDir,
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c: Buffer) => {
        const s = c.toString("utf8");
        stdout += s;
        process.stdout.write(`[openclaw skills install ${req.ref}] ${s}`);
      });
      child.stderr?.on("data", (c: Buffer) => {
        const s = c.toString("utf8");
        stderr += s;
        process.stderr.write(`[openclaw skills install ${req.ref}] ${s}`);
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new ClawhubInstallError(
            req,
            `install timed out after ${INSTALL_TIMEOUT_MS}ms`,
            { stdout, stderr },
          ),
        );
      }, INSTALL_TIMEOUT_MS);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(
          new ClawhubInstallError(
            req,
            `failed to spawn ${this.binary}: ${err.message}`,
            { stdout, stderr },
          ),
        );
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        reject(
          new ClawhubInstallError(
            req,
            `exited code=${code} signal=${signal ?? "none"}`,
            { stdout, stderr },
          ),
        );
      });
    });
  }
}

export class ClawhubInstallError extends Error {
  constructor(
    public readonly req: SkillRequirement,
    detail: string,
    public readonly output: { stdout: string; stderr: string },
  ) {
    super(
      `clawhub install failed for ${req.ref}@${req.version}: ${detail}\n` +
        `stderr (tail): ${output.stderr.slice(-500)}`,
    );
    this.name = "ClawhubInstallError";
  }
}
