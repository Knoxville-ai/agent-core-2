import { spawn } from "node:child_process";
import { dirname } from "node:path";

import { log } from "../log.js";
import { ensureOpenclawTempDir } from "../openclaw/temp-dir.js";

/**
 * Ask OpenClaw which installed skills it will actually show the model.
 *
 * Files on disk are necessary but not sufficient: OpenClaw hides a skill whose
 * `metadata.openclaw.requires` isn't met (an env var with no value, a binary not
 * on PATH, a config path, an OS). SkillSync runs `openclaw skills check --json`
 * after a change, with the same environment the gateway gets, and reports
 * `ineligible` with exactly what is missing — so the console can say "bind
 * ODOO_MCP_TOKEN" instead of the agent silently lacking the skill.
 *
 * Verified shape (openclaw 2026.5.20):
 *
 *   { "eligible": ["ok-skill", …],
 *     "missingRequirements": [
 *       { "name": "needs-env",
 *         "missing": { "bins": [], "anyBins": [], "env": ["ODOO_MCP_TOKEN"],
 *                      "config": [], "os": [] },
 *         "install": [] } ], … }
 *
 * Best effort: when the command fails or prints something else, eligibility is
 * skipped (null) and skills are reported plainly `installed`.
 */

const CHECK_TIMEOUT_MS = 60_000;

export interface SkillEligibility {
  eligible: boolean;
  missing_env: string[];
  /** `requires.bins` not found, plus every `requires.anyBins` alternative when
   *  none of them was found. */
  missing_bins: string[];
  missing_config: string[];
  missing_os: string[];
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Parse `openclaw skills check --json` output into per-skill-name eligibility.
 *  Returns null when the document isn't the expected shape. Pure. */
export function parseSkillsCheck(doc: unknown): Map<string, SkillEligibility> | null {
  if (!isRecord(doc)) return null;
  if (!Array.isArray(doc.eligible) || !Array.isArray(doc.missingRequirements)) return null;
  const out = new Map<string, SkillEligibility>();
  for (const name of strings(doc.eligible)) {
    out.set(name, { eligible: true, missing_env: [], missing_bins: [], missing_config: [], missing_os: [] });
  }
  for (const item of doc.missingRequirements) {
    if (!isRecord(item) || typeof item.name !== "string") continue;
    const missing = isRecord(item.missing) ? item.missing : {};
    const bins = [...new Set([...strings(missing.bins), ...strings(missing.anyBins)])];
    out.set(item.name, {
      eligible: false,
      missing_env: strings(missing.env),
      missing_bins: bins,
      missing_config: strings(missing.config),
      missing_os: strings(missing.os),
    });
  }
  return out;
}

/** Parse CLI stdout leniently: the JSON document may be preceded by log lines. */
export function parseCheckOutput(stdout: string): Map<string, SkillEligibility> | null {
  const text = stdout.trim();
  const candidates = [text];
  const firstBrace = text.indexOf("\n{");
  if (firstBrace >= 0) candidates.push(text.slice(firstBrace + 1));
  for (const c of candidates) {
    try {
      const parsed = parseSkillsCheck(JSON.parse(c));
      if (parsed) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export type EligibilityChecker = () => Promise<Map<string, SkillEligibility> | null>;

export interface OpenclawEligibilityOptions {
  stateDir: string;
  /** Binary name or absolute path. Defaults to `openclaw` on PATH. */
  binary?: string;
  timeoutMs?: number;
}

/**
 * The real checker: `openclaw skills check --json` with the env the gateway and
 * the ClawHub resolver use (HOME/OPENCLAW_HOME = parent of the state dir,
 * OPENCLAW_STATE_DIR, a private TMPDIR) so it sees the same config, workspace
 * and credentials the running agent does. Never throws.
 */
export function openclawEligibilityChecker(opts: OpenclawEligibilityOptions): EligibilityChecker {
  const binary = opts.binary ?? "openclaw";
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  return () =>
    new Promise((resolve) => {
      const userHome = dirname(opts.stateDir);
      const tempDir = ensureOpenclawTempDir(opts.stateDir);
      let child;
      try {
        child = spawn(binary, ["skills", "check", "--json"], {
          env: {
            ...process.env,
            HOME: userHome,
            OPENCLAW_HOME: userHome,
            OPENCLAW_STATE_DIR: opts.stateDir,
            TMPDIR: tempDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        log.warn("skills eligibility check could not start; skipping", { err: String(err) });
        resolve(null);
        return;
      }
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
      });
      child.stderr?.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        log.warn("skills eligibility check failed to spawn; skipping", { err: String(err) });
        resolve(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          log.warn("skills eligibility check exited non-zero; skipping", {
            code,
            stderr: stderr.slice(-500),
          });
          resolve(null);
          return;
        }
        const parsed = parseCheckOutput(stdout);
        if (!parsed) {
          log.warn("skills eligibility check printed an unknown shape; skipping", {
            head: stdout.slice(0, 200),
          });
        }
        resolve(parsed);
      });
    });
}
