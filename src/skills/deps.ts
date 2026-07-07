import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { log } from "../log.js";
import type { InstalledSkill } from "./resolver.js";

/**
 * Provision the Python dependencies each installed skill declares in its
 * `SKILL.md` frontmatter (`metadata.openclaw.install.uv`) into the SAME
 * interpreter the agent shells out to at runtime — bare `python3`, which the
 * image's PATH resolves to `/opt/skills-venv/bin/python3`.
 *
 * Why this exists: skills are synced at RUNTIME, not baked into the image.
 * `workspace/skills/` is wiped + reinstalled from the bundle + console boot
 * list on every boot (see boot/bootstrap.ts), and the live `/skills/install`
 * route adds more without a redeploy. `openclaw skills install` only unpacks a
 * skill's files; nothing installs the skill's declared `install.uv`
 * requirements into the interpreter the agent later invokes as
 * `python3 scripts/foo.py`. Without this step those scripts die with
 * ModuleNotFoundError — e.g. drivethru-odoo imports the `mcp` SDK, which pulls
 * `anyio`, and the bare interpreter has neither.
 *
 * Reading the deps from each `SKILL.md` (rather than hardcoding a per-skill
 * list in the Dockerfile) means a newly-installed skill's deps are covered
 * automatically, and it targets the interpreter the agent actually uses rather
 * than an ephemeral `uv run --with` env that never reaches `python3`.
 *
 * Posture: soft-fail. A dep-install hiccup (transient PyPI outage, etc.)
 * degrades the affected skill; it must not brick the whole agent boot — the
 * same posture as the console boot-list install and manifest refresh.
 */

/** uv/pip can pull a lot of transitive weight (onnxruntime, playwright, ...),
 *  so give each install a generous ceiling before we kill it. */
const INSTALL_TIMEOUT_MS = 600_000;
const PROBE_TIMEOUT_MS = 15_000;

/** SKILL.md frontmatter is a leading `---`-fenced YAML block. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/** Parse the leading YAML frontmatter of a SKILL.md. Returns the parsed value,
 *  or null when there is no frontmatter or it fails to parse. */
export function parseFrontmatter(md: string): unknown {
  // Strip a leading UTF-8 BOM so `---` still anchors at the start.
  const m = FRONTMATTER_RE.exec(md.replace(/^\uFEFF/, ""));
  if (!m) return null;
  try {
    return parseYaml(m[1]!);
  } catch {
    return null;
  }
}

/** Safe property read: returns undefined unless `v` is a plain object. */
function getProp(v: unknown, key: string): unknown {
  return v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
}

/** Dig `metadata.openclaw.install.uv` out of parsed frontmatter. Defensive at
 *  every level; returns the trimmed, non-empty pip requirement strings, or []
 *  when the path is absent or malformed. */
export function extractUvRequirements(frontmatter: unknown): string[] {
  const install = getProp(getProp(getProp(frontmatter, "metadata"), "openclaw"), "install");
  const uv = getProp(install, "uv");
  if (!Array.isArray(uv)) return [];
  return uv
    .filter((r): r is string => typeof r === "string" && r.trim() !== "")
    .map((r) => r.trim());
}

/** The pip package name at the head of a PEP 508 requirement string, lowercased
 *  and PEP 503-normalized so `Playwright[chromium]>=1.40` → `playwright`. */
export function requirementName(req: string): string {
  const head = req.trim().split(/[\s<>=!~;[\](),@]/, 1)[0] ?? "";
  return head.toLowerCase().replace(/[-_.]+/g, "-");
}

/** A skill needs the Chromium browser binary when it depends on Playwright:
 *  the pip package ships the driver, but the browser build is a separate
 *  `playwright install chromium` download. */
export function needsChromium(requirements: string[]): boolean {
  return requirements.some((r) => requirementName(r) === "playwright");
}

export interface CollectedDeps {
  /** Deduped union of every skill's `install.uv`, in stable first-seen order. */
  requirements: string[];
  /** True when any requirement is Playwright (needs the browser binary too). */
  needsChromium: boolean;
  /** Refs of the skills that contributed at least one requirement (logging). */
  skillsWithDeps: string[];
}

async function readSkillMd(skillDir: string): Promise<string | null> {
  try {
    return await readFile(join(skillDir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

/**
 * Walk each installed skill, read its SKILL.md, and union the declared uv
 * requirements (deduped, stable order). Soft per skill: a missing or garbled
 * SKILL.md contributes nothing rather than throwing. `readMd` is injectable so
 * the collection logic is unit-testable without touching the filesystem.
 */
export async function collectSkillDeps(
  skills: Pick<InstalledSkill, "ref" | "path">[],
  readMd: (dir: string) => Promise<string | null> = readSkillMd,
): Promise<CollectedDeps> {
  const seen = new Set<string>();
  const requirements: string[] = [];
  const skillsWithDeps: string[] = [];
  for (const skill of skills) {
    const md = await readMd(skill.path);
    if (md == null) continue;
    const reqs = extractUvRequirements(parseFrontmatter(md));
    if (reqs.length === 0) continue;
    skillsWithDeps.push(skill.ref);
    for (const r of reqs) {
      if (seen.has(r)) continue;
      seen.add(r);
      requirements.push(r);
    }
  }
  return { requirements, needsChromium: needsChromium(requirements), skillsWithDeps };
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: Error;
}

/** Run a command, streaming its output through so long installs are visible in
 *  the container logs. Never rejects — failures surface as `code`/`spawnError`
 *  in the resolved value so callers can soft-fail. */
function exec(cmd: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      const s = c.toString("utf8");
      stdout += s;
      process.stdout.write(`[skill-deps ${cmd}] ${s}`);
    });
    child.stderr?.on("data", (c: Buffer) => {
      const s = c.toString("utf8");
      stderr += s;
      process.stderr.write(`[skill-deps ${cmd}] ${s}`);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stdout, stderr: `${stderr}\n[timed out after ${timeoutMs}ms]` });
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, spawnError: err });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Resolve the interpreter bare `python3` resolves to on the current PATH — the
 *  exact one the agent shells out to. Returns its absolute path (a venv's
 *  sys.executable), or null when no python3 is on PATH. */
async function resolveAgentPython(): Promise<string | null> {
  const r = await exec("python3", ["-c", "import sys; print(sys.executable)"], PROBE_TIMEOUT_MS);
  if (r.code === 0) {
    const path = r.stdout.trim().split(/\r?\n/).pop()?.trim();
    if (path) return path;
  }
  log.error("skill deps: no python3 interpreter on PATH", {
    err: r.spawnError ? String(r.spawnError) : `exit ${r.code}`,
  });
  return null;
}

/** Install the pip requirements into `python`. Prefers `uv` (fast, present in
 *  the skills-venv); falls back to `pip --break-system-packages` if uv is
 *  absent or fails. Returns true on success. */
async function installRequirements(python: string, requirements: string[]): Promise<boolean> {
  // Point uv at the exact interpreter the agent uses so packages land where
  // `python3 scripts/foo.py` will import them. The target is a venv, so PEP
  // 668's externally-managed marker doesn't apply; the pip fallback still
  // passes --break-system-packages in case python3 ever resolves to a
  // system interpreter.
  const uv = await exec("uv", ["pip", "install", "--python", python, ...requirements], INSTALL_TIMEOUT_MS);
  if (uv.code === 0) return true;
  log.warn("skill deps: `uv pip install` unavailable/failed, falling back to pip", {
    err: uv.spawnError ? String(uv.spawnError) : `exit ${uv.code}`,
    stderr: uv.stderr.slice(-500),
  });
  const pip = await exec(
    python,
    ["-m", "pip", "install", "--break-system-packages", ...requirements],
    INSTALL_TIMEOUT_MS,
  );
  if (pip.code === 0) return true;
  log.error("skill deps: pip install failed", {
    err: pip.spawnError ? String(pip.spawnError) : `exit ${pip.code}`,
    stderr: pip.stderr.slice(-500),
  });
  return false;
}

/** Fetch the Playwright Chromium build for `python`. Idempotent: with the
 *  browser pre-baked into PLAYWRIGHT_BROWSERS_PATH at build time this reports
 *  "already installed" and returns fast. Returns true on success. */
async function installChromium(python: string): Promise<boolean> {
  const r = await exec(python, ["-m", "playwright", "install", "chromium"], INSTALL_TIMEOUT_MS);
  if (r.code === 0) return true;
  log.error("skill deps: `playwright install chromium` failed", {
    err: r.spawnError ? String(r.spawnError) : `exit ${r.code}`,
    stderr: r.stderr.slice(-500),
  });
  return false;
}

/**
 * Install every installed skill's declared `install.uv` requirements into the
 * agent's `python3`, plus the Playwright Chromium build for any browser skill.
 * Idempotent (uv/pip skip already-satisfied requirements) and soft-fail: logs
 * and returns rather than throwing so a dep hiccup can't brick the boot. Call
 * after skills are installed and before the gateway spawns them.
 */
export async function provisionSkillDeps(skills: InstalledSkill[]): Promise<void> {
  const { requirements, needsChromium: wantChromium, skillsWithDeps } = await collectSkillDeps(skills);
  if (requirements.length === 0) {
    log.debug("skill deps: no install.uv requirements declared");
    return;
  }
  const python = await resolveAgentPython();
  if (!python) {
    log.error("skill deps: cannot provision — no python3 resolved", { requirements });
    return;
  }
  log.info("skill deps: installing", {
    python,
    count: requirements.length,
    requirements,
    skills: skillsWithDeps,
    chromium: wantChromium,
  });
  if (await installRequirements(python, requirements)) {
    log.info("skill deps: install.uv requirements ready", { count: requirements.length });
  }
  if (wantChromium && (await installChromium(python))) {
    log.info("skill deps: chromium browser ready");
  }
}
