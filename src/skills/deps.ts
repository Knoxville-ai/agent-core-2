import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
 * SkillSync (./sync.ts) materializes platform-library skills into
 * `workspace/skills/` at boot and while the agent runs, and the legacy path
 * (bundle + console boot list via ClawHub) does the same for older consoles.
 * Neither installs the skill's declared `install.uv` requirements into the
 * interpreter the agent later invokes as `python3 scripts/foo.py`. Without this
 * step those scripts die with ModuleNotFoundError — e.g. drivethru-odoo imports
 * the `mcp` SDK, which pulls `anyio`, and the bare interpreter has neither.
 *
 * Reading the deps from each `SKILL.md` (rather than hardcoding a per-skill
 * list in the Dockerfile) means a newly-installed skill's deps are covered
 * automatically, and it targets the interpreter the agent actually uses rather
 * than an ephemeral `uv run --with` env that never reaches `python3`.
 *
 * Two entry points:
 *   - `provisionSkillDepsFor(dir)` — ONE skill, before SkillSync activates it.
 *     Returns `{ ok, error }` so a failure keeps the old version live, and skips
 *     `uv` entirely when the requirement hash matches what is already provisioned.
 *   - `provisionSkillDeps(skills)` — the legacy union install (soft-fail), used
 *     by the legacy boot path and the deprecated `/skills/install` route.
 */

/** uv/pip can pull a lot of transitive weight (onnxruntime, playwright, ...),
 *  so give each install a generous ceiling before we kill it. */
const INSTALL_TIMEOUT_MS = 600_000;
const PROBE_TIMEOUT_MS = 15_000;
/** How much of a failed install's stderr is kept for the sync report. */
const ERROR_TAIL_CHARS = 1500;

// ---------------------------------------------------------------------------
// Frontmatter (lenient)
// ---------------------------------------------------------------------------

/** SKILL.md frontmatter is a leading `---`-fenced YAML block. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/** A top-level `key:` line at column 0 (the line-based fallback's entry start). */
const TOP_LEVEL_KEY_RE = /^([A-Za-z0-9_-]+):(.*)$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Strip ONE pair of matching surrounding single or double quotes. */
function stripOuterQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/** A blank line, or a YAML comment line: belongs to the entry above it but is
 *  not content of its own. */
function isFiller(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

/**
 * Line-based fallback for frontmatter strict YAML rejects. OpenClaw itself
 * reads frontmatter line by line, so a skill whose one-line `description:`
 * carries an unquoted `": "` (strict YAML: "Nested mappings are not allowed in
 * compact mappings") still loads in the runtime — and must load here too.
 *
 *   - A column-0 line matching `^([A-Za-z0-9_-]+):(.*)$` starts an entry; the
 *     lines after it that are indented, blank, or comments belong to it. Any
 *     other column-0 line ends the entry and is ignored.
 *   - An entry with no content lines after it (only blanks/comments, or none)
 *     takes the trimmed rest-of-line as a plain string, minus one pair of
 *     surrounding quotes.
 *   - Otherwise `"<key>:<rest>\n<continuation>"` is parsed with strict YAML on
 *     its own and that key is taken; if that fails too, the entry is skipped.
 *
 * Returns null when nothing could be recovered. The console parses SKILL.md
 * with the same algorithm, so both sides agree on `name` and requirements.
 */
export function parseFrontmatterLines(block: string): Record<string, unknown> | null {
  interface Entry {
    key: string;
    rest: string;
    continuation: string[];
  }
  const entries: Entry[] = [];
  let current: Entry | null = null;
  for (const line of block.split(/\r?\n/)) {
    const m = TOP_LEVEL_KEY_RE.exec(line);
    if (m) {
      current = { key: m[1]!, rest: m[2]!, continuation: [] };
      entries.push(current);
      continue;
    }
    if (current && (isFiller(line) || /^\s/.test(line))) {
      current.continuation.push(line);
      continue;
    }
    current = null;
  }

  const out: Record<string, unknown> = {};
  for (const e of entries) {
    if (!e.continuation.some((l) => !isFiller(l))) {
      out[e.key] = stripOuterQuotes(e.rest.trim());
      continue;
    }
    try {
      const parsed: unknown = parseYaml(`${e.key}:${e.rest}\n${e.continuation.join("\n")}`);
      if (isPlainObject(parsed) && Object.prototype.hasOwnProperty.call(parsed, e.key)) {
        out[e.key] = parsed[e.key];
      }
    } catch {
      // Unparseable on its own too — skip just this entry.
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Parse a frontmatter block: strict YAML first, then the line-based fallback.
 *  Returns a mapping, or null when nothing usable is there. */
export function parseFrontmatterBlock(block: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = parseYaml(block);
    if (isPlainObject(parsed)) return parsed;
  } catch {
    // fall through to the lenient parser
  }
  return parseFrontmatterLines(block);
}

/** Parse the leading frontmatter of a SKILL.md (leniently — see
 *  `parseFrontmatterLines`). Returns null when there is no frontmatter or
 *  nothing in it could be recovered. */
export function parseFrontmatter(md: string): Record<string, unknown> | null {
  // Strip a leading UTF-8 BOM so `---` still anchors at the start.
  const m = FRONTMATTER_RE.exec(md.replace(/^﻿/, ""));
  if (!m) return null;
  return parseFrontmatterBlock(m[1]!);
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

/** `metadata.openclaw.skillKey` (the `skills.entries` key OpenClaw uses for the
 *  skill), or null when the skill doesn't set one. */
export function extractSkillKey(frontmatter: unknown): string | null {
  const key = getProp(getProp(getProp(frontmatter, "metadata"), "openclaw"), "skillKey");
  return typeof key === "string" && key.trim() !== "" ? key.trim() : null;
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

/** The `install.uv` requirements a skill directory declares ([] when none, or
 *  when SKILL.md is missing/unparseable). */
export async function readSkillUvRequirements(skillDir: string): Promise<string[]> {
  const md = await readSkillMd(skillDir);
  return md == null ? [] : extractUvRequirements(parseFrontmatter(md));
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

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

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

function failureTail(r: ExecResult): string {
  const head = r.spawnError ? String(r.spawnError) : `exit ${r.code}`;
  const tail = r.stderr.trim().slice(-ERROR_TAIL_CHARS);
  return tail ? `${head}: ${tail}` : head;
}

/** Where bare `python3` points, plus the venv prefix it lives in. */
export interface AgentPython {
  /** sys.executable — the exact interpreter the agent shells out to. */
  python: string;
  /** sys.prefix — the venv root (where the identity marker lives). */
  prefix: string;
}

/** Resolve the interpreter bare `python3` resolves to on the current PATH — the
 *  exact one the agent shells out to. Returns null when no python3 is on PATH. */
async function resolveAgentPython(): Promise<AgentPython | null> {
  const r = await exec(
    "python3",
    ["-c", "import sys; print(sys.executable); print(sys.prefix)"],
    PROBE_TIMEOUT_MS,
  );
  if (r.code === 0) {
    const lines = r.stdout.trim().split(/\r?\n/).map((l) => l.trim());
    const prefix = lines.pop();
    const python = lines.pop();
    if (python && prefix) return { python, prefix };
  }
  log.error("skill deps: no python3 interpreter on PATH", {
    err: r.spawnError ? String(r.spawnError) : `exit ${r.code}`,
  });
  return null;
}

/** Install the pip requirements into `python`. Prefers `uv` (fast, present in
 *  the skills-venv); falls back to `pip --break-system-packages` if uv is
 *  absent or fails. */
async function installRequirements(
  python: string,
  requirements: string[],
): Promise<{ ok: boolean; error?: string }> {
  // Point uv at the exact interpreter the agent uses so packages land where
  // `python3 scripts/foo.py` will import them. The target is a venv, so PEP
  // 668's externally-managed marker doesn't apply; the pip fallback still
  // passes --break-system-packages in case python3 ever resolves to a
  // system interpreter.
  const uv = await exec("uv", ["pip", "install", "--python", python, ...requirements], INSTALL_TIMEOUT_MS);
  if (uv.code === 0) return { ok: true };
  log.warn("skill deps: `uv pip install` unavailable/failed, falling back to pip", {
    err: uv.spawnError ? String(uv.spawnError) : `exit ${uv.code}`,
    stderr: uv.stderr.slice(-500),
  });
  const pip = await exec(
    python,
    ["-m", "pip", "install", "--break-system-packages", ...requirements],
    INSTALL_TIMEOUT_MS,
  );
  if (pip.code === 0) return { ok: true };
  log.error("skill deps: pip install failed", {
    err: pip.spawnError ? String(pip.spawnError) : `exit ${pip.code}`,
    stderr: pip.stderr.slice(-500),
  });
  // uv's message is usually the useful one (resolver conflict, missing wheel);
  // keep it when uv actually ran, else pip's.
  return { ok: false, error: uv.spawnError ? failureTail(pip) : failureTail(uv) };
}

/** Fetch the Playwright Chromium build for `python`. Idempotent: with the
 *  browser pre-baked into PLAYWRIGHT_BROWSERS_PATH at build time this reports
 *  "already installed" and returns fast. */
async function installChromium(python: string): Promise<{ ok: boolean; error?: string }> {
  const r = await exec(python, ["-m", "playwright", "install", "chromium"], INSTALL_TIMEOUT_MS);
  if (r.code === 0) return { ok: true };
  log.error("skill deps: `playwright install chromium` failed", {
    err: r.spawnError ? String(r.spawnError) : `exit ${r.code}`,
    stderr: r.stderr.slice(-500),
  });
  return { ok: false, error: failureTail(r) };
}

// ---------------------------------------------------------------------------
// Interpreter identity
// ---------------------------------------------------------------------------

/** Marker file in the venv root naming this particular venv instance. */
const VENV_ID_FILE = ".knox-venv-id";

/**
 * A stable id for the venv packages are installed into. The skills venv lives
 * in the IMAGE (/opt/skills-venv), not on the volume: every container restart
 * or redeploy starts from the image's baseline packages, while the lock file
 * (with its `deps_hash`) survives on the volume. Folding this id into the deps
 * hash means "requirements unchanged" can only skip `uv` for the venv instance
 * that actually received them — a fresh container gets a fresh id (the marker
 * is gone with the old writable layer) and re-provisions every skill's deps.
 * Returns null when no marker can be read or written (never skip, then).
 */
async function venvIdentity(prefix: string): Promise<string | null> {
  const path = join(prefix, VENV_ID_FILE);
  try {
    const id = (await readFile(path, "utf8")).trim();
    if (id) return id;
  } catch {
    // absent → create below
  }
  const id = randomUUID();
  try {
    await writeFile(path, `${id}\n`, { flag: "wx" });
    return id;
  } catch {
    // Lost a race with another writer, or the venv isn't writable.
    try {
      const raced = (await readFile(path, "utf8")).trim();
      return raced || null;
    } catch {
      return null;
    }
  }
}

/**
 * The hash SkillSync records as a skill's `deps_hash`: sha256 over the venv
 * identity and the requirement list (in declared order). null when the skill
 * declares no requirements, or when the venv can't be identified (so the
 * install is never skipped on a guess).
 */
export function depsHash(requirements: string[], venvId: string | null): string | null {
  if (requirements.length === 0 || !venvId) return null;
  return createHash("sha256")
    .update(`venv=${venvId}\n${requirements.join("\n")}`)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Per-skill provisioning (SkillSync)
// ---------------------------------------------------------------------------

/** The side-effecting half of per-skill provisioning, injectable for tests. */
export interface DepsRunner {
  /** The agent's interpreter and a stable id for its venv (id null = unknown). */
  interpreter(): Promise<{ python: string; venvId: string | null } | null>;
  install(python: string, requirements: string[]): Promise<{ ok: boolean; error?: string }>;
  installChromium(python: string): Promise<{ ok: boolean; error?: string }>;
}

let cachedInterpreter: Promise<{ python: string; venvId: string | null } | null> | null = null;

/** The real runner: `python3` on PATH, `uv` (pip fallback), playwright. The
 *  interpreter probe is cached for the life of the process. */
export const defaultDepsRunner: DepsRunner = {
  interpreter() {
    if (!cachedInterpreter) {
      cachedInterpreter = (async () => {
        const resolved = await resolveAgentPython();
        if (!resolved) return null;
        return { python: resolved.python, venvId: await venvIdentity(resolved.prefix) };
      })();
      // Don't pin a failed probe (no python3 yet) for the life of the process.
      void cachedInterpreter.then((r) => {
        if (!r) cachedInterpreter = null;
      });
    }
    return cachedInterpreter;
  },
  install: installRequirements,
  installChromium,
};

export interface SkillDepsResult {
  ok: boolean;
  /** True when nothing ran: no requirements, or the hash matched. */
  skipped: boolean;
  /** What to record as the skill's `deps_hash` (null: none / unknown venv). */
  hash: string | null;
  requirements: string[];
  /** Failure detail (stderr tail) when `ok` is false. */
  error?: string;
}

/**
 * Install ONE skill's declared Python deps (SKILL.md →
 * `metadata.openclaw.install.uv`) into the agent's interpreter, plus Chromium
 * for a Playwright skill. Call BEFORE the skill is activated: on failure the
 * caller keeps the old version live and reports `failed` with `error`.
 * Skips entirely when the requirement hash equals `previousHash` (an update
 * that doesn't touch deps costs nothing). Never throws.
 */
export async function provisionSkillDepsFor(
  skillDir: string,
  opts: { previousHash?: string | null; runner?: DepsRunner; label?: string } = {},
): Promise<SkillDepsResult> {
  const runner = opts.runner ?? defaultDepsRunner;
  const requirements = await readSkillUvRequirements(skillDir);
  if (requirements.length === 0) {
    return { ok: true, skipped: true, hash: null, requirements };
  }
  const interp = await runner.interpreter();
  if (!interp) {
    return {
      ok: false,
      skipped: false,
      hash: null,
      requirements,
      error: "no python3 interpreter on PATH to install install.uv requirements into",
    };
  }
  const hash = depsHash(requirements, interp.venvId);
  if (hash && opts.previousHash && hash === opts.previousHash) {
    log.debug("skill deps: unchanged, skipping", { skill: opts.label ?? skillDir });
    return { ok: true, skipped: true, hash, requirements };
  }
  log.info("skill deps: installing", {
    skill: opts.label ?? skillDir,
    python: interp.python,
    requirements,
  });
  const installed = await runner.install(interp.python, requirements);
  if (!installed.ok) {
    return { ok: false, skipped: false, hash: null, requirements, error: installed.error };
  }
  if (needsChromium(requirements)) {
    const chromium = await runner.installChromium(interp.python);
    if (!chromium.ok) {
      return {
        ok: false,
        skipped: false,
        hash: null,
        requirements,
        error: `playwright chromium: ${chromium.error ?? "failed"}`,
      };
    }
  }
  return { ok: true, skipped: false, hash, requirements };
}

// ---------------------------------------------------------------------------
// Legacy union install
// ---------------------------------------------------------------------------

/**
 * Install every installed skill's declared `install.uv` requirements into the
 * agent's `python3`, plus the Playwright Chromium build for any browser skill.
 * Idempotent (uv/pip skip already-satisfied requirements) and soft-fail: logs
 * and returns rather than throwing so a dep hiccup can't brick the boot. Used
 * by the LEGACY paths (bundle + boot list at boot, the deprecated
 * `/skills/install`); SkillSync uses `provisionSkillDepsFor` per skill.
 */
export async function provisionSkillDeps(skills: InstalledSkill[]): Promise<void> {
  const { requirements, needsChromium: wantChromium, skillsWithDeps } = await collectSkillDeps(skills);
  if (requirements.length === 0) {
    log.debug("skill deps: no install.uv requirements declared");
    return;
  }
  const resolved = await resolveAgentPython();
  if (!resolved) {
    log.error("skill deps: cannot provision — no python3 resolved", { requirements });
    return;
  }
  const python = resolved.python;
  log.info("skill deps: installing", {
    python,
    count: requirements.length,
    requirements,
    skills: skillsWithDeps,
    chromium: wantChromium,
  });
  if ((await installRequirements(python, requirements)).ok) {
    log.info("skill deps: install.uv requirements ready", { count: requirements.length });
  }
  if (wantChromium && (await installChromium(python)).ok) {
    log.info("skill deps: chromium browser ready");
  }
}
