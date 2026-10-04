import { readdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { ClawhubSkillResolver } from "../skills/clawhub.js";
import { provisionSkillDeps } from "../skills/deps.js";
import { bumpSkillRevs, freshRev, type RevChange } from "../skills/refresh.js";
import type { InstalledSkill } from "../skills/resolver.js";
import type { LegacyInstaller, SkillSync } from "../skills/sync.js";
import { HttpError } from "./auth.js";
import { requireGatewayToken } from "./routes-files.js";
import { readJsonBody, sendJson } from "./util.js";

/**
 * Live skill surface, gateway-token authed (same operator capability as
 * `/files/*`; only the console server holds OPENCLAW_GATEWAY_TOKEN).
 *
 *   POST   /skills/sync       -> 200 applied | 202 in_progress | 409 legacy
 *                                body { generation? } — the console's nudge after
 *                                any desired-state change (SkillSync, ../skills/sync.ts)
 *   GET    /skills            -> what is installed (the SkillSync lock in library
 *                                mode; the folders under workspace/skills otherwise)
 *   POST   /skills/install    -> { ok, skill } ; body { slug, version? }   [deprecated]
 *   DELETE /skills/{slug}     -> { ok }                                     [deprecated]
 *   GET    /skills/search     -> 501 (registry search isn't served here)
 *
 * Nothing here restarts the gateway. A change becomes visible to every session
 * on its next turn through a `skills.entries.<key>.config.rev` bump in
 * openclaw.json, which the gateway hot-reloads (../skills/refresh.ts).
 *
 * The deprecated install/remove pair is the ClawHub path an older console
 * (one without the skills library) still uses. Once SkillSync owns
 * `workspace/skills/` (library mode) they answer 409: a ClawHub folder dropped
 * in by hand would be quarantined by the next reconcile, and a removed library
 * skill would be put straight back.
 */

const SLUG_RE = /^[a-zA-Z0-9@._/-]+$/;
const VERSION_RE = /^[a-zA-Z0-9._-]+$/;
/** How long POST /skills/sync waits for a completed run before answering 202. */
export const SKILL_SYNC_WAIT_MS = 25_000;

export interface SkillsRouteDeps {
  env: AgentEnv;
  /** null when the platform MCP isn't configured (no library). */
  sync: SkillSync | null;
  /** Injectable for tests; default ClawhubSkillResolver. */
  legacyInstaller?: LegacyInstaller;
  /** Injectable for tests; default the legacy union deps install. */
  provisionDeps?: (skills: InstalledSkill[]) => Promise<void>;
  /** Injectable for tests; default bumpSkillRevs on the state dir. */
  refresh?: (changes: RevChange[]) => Promise<unknown>;
  /** Injectable for tests; default SKILL_SYNC_WAIT_MS. */
  syncWaitMs?: number;
}

function skillsRoot(env: AgentEnv): string {
  return join(env.OPENCLAW_STATE_DIR, "workspace", "skills");
}

function refreshOf(deps: SkillsRouteDeps): (changes: RevChange[]) => Promise<unknown> {
  return deps.refresh ?? ((changes) => bumpSkillRevs(deps.env.OPENCLAW_STATE_DIR, changes));
}

/** Library mode: SkillSync owns workspace/skills/. */
function libraryMode(deps: SkillsRouteDeps): boolean {
  return deps.sync?.mode === "library";
}

function refuseInLibraryMode(res: ServerResponse): void {
  sendJson(res, 409, {
    ok: false,
    status: "library",
    error:
      "this agent's skills are managed by the platform skills library; change them in the console (POST /skills/sync applies the change)",
  });
}

/**
 * Resolve `<skillsRoot>/<slug>` and confirm it stays strictly inside the skills
 * dir. The console's slug grammar permits `/` and `.`, so `../..`-style slugs
 * would otherwise let a DELETE `rm -rf` escape the workspace. Pure + exported
 * for unit testing. Returns null if the slug escapes (or is empty).
 */
export function safeSkillDir(root: string, slug: string): string | null {
  if (!slug || !SLUG_RE.test(slug)) return null;
  const resolvedRoot = resolve(root);
  const target = resolve(join(root, slug));
  if (target === resolvedRoot) return null; // the root itself, not a skill
  if (!target.startsWith(resolvedRoot + sep)) return null; // escaped the root
  return target;
}

export async function handleSkillsList(res: ServerResponse, deps: SkillsRouteDeps): Promise<void> {
  if (deps.sync && libraryMode(deps)) {
    sendJson(res, 200, await deps.sync.status());
    return;
  }
  let names: string[] = [];
  try {
    const entries = await readdir(skillsRoot(deps.env), { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch {
    // Dir absent (nothing installed yet) → empty list, not an error.
    names = [];
  }
  // Legacy view: versions aren't tracked here; the console pairs this with its
  // boot list (config/skills.json), which carries the pins.
  sendJson(res, 200, {
    mode: deps.sync ? deps.sync.mode : "disabled",
    generation: null,
    lock_digest: null,
    skills: names.sort().map((slug) => ({ slug, version: null, source: "clawhub" as const })),
  });
}

interface InstallBody {
  slug?: unknown;
  version?: unknown;
}

/** [deprecated] Install a ClawHub skill into the running agent (older consoles). */
export async function handleSkillsInstall(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SkillsRouteDeps,
): Promise<void> {
  const body = (await readJsonBody<InstallBody>(req)) ?? {};
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const version =
    typeof body.version === "string" && body.version.trim() !== ""
      ? body.version.trim()
      : "";
  if (!slug || !SLUG_RE.test(slug) || !safeSkillDir(skillsRoot(deps.env), slug)) {
    throw new HttpError(400, "invalid slug");
  }
  if (version && !VERSION_RE.test(version)) throw new HttpError(400, "invalid version");
  if (libraryMode(deps)) return refuseInLibraryMode(res);

  const resolver =
    deps.legacyInstaller ?? new ClawhubSkillResolver({ stateDir: deps.env.OPENCLAW_STATE_DIR });
  const installed = await resolver.install(
    { source: "clawhub", ref: slug, version },
    skillsRoot(deps.env),
  );
  // Install the newly-added skill's declared Python deps (SKILL.md →
  // metadata.openclaw.install.uv) into the agent's interpreter BEFORE the
  // refresh below makes sessions list it, so a `python3 scripts/foo.py`
  // invocation doesn't fail with ModuleNotFoundError on first use.
  await (deps.provisionDeps ?? provisionSkillDeps)([installed]);
  // Make the running gateway re-read workspace/skills on every session's next
  // turn — a skills.* config bump the gateway hot-reloads. No restart, so no
  // in-flight turn is interrupted.
  const refreshed = await refreshOf(deps)([{ key: slug, rev: freshRev() }]).then(
    () => true,
    (err: unknown) => {
      log.error("skills refresh after live install failed", { slug, err: String(err) });
      return false;
    },
  );
  log.info("live skill installed", { slug, version: version || "(latest)", refreshed });
  sendJson(res, 200, {
    ok: true,
    skill: { slug, version: version || null, source: installed.source },
  });
}

/** [deprecated] Remove a skill folder from the running agent (older consoles). */
export async function handleSkillsRemove(
  slug: string,
  res: ServerResponse,
  deps: SkillsRouteDeps,
): Promise<void> {
  const dir = safeSkillDir(skillsRoot(deps.env), slug);
  if (!dir) throw new HttpError(400, "invalid slug");
  if (libraryMode(deps)) return refuseInLibraryMode(res);
  await rm(dir, { recursive: true, force: true });
  // Drop the skill from every session's list on its next turn (no restart).
  const refreshed = await refreshOf(deps)([{ key: slug, remove: true }]).then(
    () => true,
    (err: unknown) => {
      log.error("skills refresh after live remove failed", { slug, err: String(err) });
      return false;
    },
  );
  log.info("live skill removed", { slug, refreshed });
  sendJson(res, 200, { ok: true });
}

interface SyncBody {
  generation?: unknown;
}

/**
 * POST /skills/sync — the console's nudge after a desired-state change. Runs or
 * joins a reconcile and waits (≤ 25s) for a completed run that applied at least
 * the requested generation:
 *
 *   200 { status: "applied", applied_generation, results }
 *   202 { status: "in_progress", generation }   still running (deps can take
 *                                               minutes) or will be retried
 *   409 { status: "legacy" }                    no skills library on this console
 *                                               (or no platform MCP): use the
 *                                               deprecated routes
 */
export async function handleSkillsSync(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SkillsRouteDeps,
): Promise<void> {
  const body = (await readJsonBody<SyncBody>(req)) ?? {};
  let generation: number | undefined;
  if (body.generation !== undefined && body.generation !== null) {
    if (typeof body.generation !== "number" || !Number.isInteger(body.generation) || body.generation < 0) {
      throw new HttpError(400, "generation must be a non-negative integer");
    }
    generation = body.generation;
  }
  if (!deps.sync) {
    sendJson(res, 409, { status: "legacy", reason: "platform MCP not configured" });
    return;
  }
  const outcome = await deps.sync.syncForNudge(generation, deps.syncWaitMs ?? SKILL_SYNC_WAIT_MS);
  switch (outcome.kind) {
    case "applied":
      sendJson(res, 200, {
        status: "applied",
        applied_generation: outcome.appliedGeneration,
        results: outcome.results,
      });
      return;
    case "in_progress":
      sendJson(res, 202, {
        status: "in_progress",
        generation: outcome.generation,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
      return;
    case "legacy":
      sendJson(res, 409, { status: "legacy" });
      return;
  }
}

/**
 * Dispatch a `/skills` or `/skills/*` request. Every route requires the gateway
 * token (`Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>`), checked first.
 */
export async function routeSkills(
  path: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: SkillsRouteDeps,
): Promise<void> {
  requireGatewayToken(req.headers.authorization, deps.env);
  if (path === "/skills") {
    if (method !== "GET") throw new HttpError(405, "method not allowed");
    return handleSkillsList(res, deps);
  }
  if (path === "/skills/sync") {
    if (method !== "POST") throw new HttpError(405, "method not allowed");
    return handleSkillsSync(req, res, deps);
  }
  if (path === "/skills/install") {
    if (method !== "POST") throw new HttpError(405, "method not allowed");
    return handleSkillsInstall(req, res, deps);
  }
  if (path === "/skills/search") {
    // Registry search isn't wired; the console treats 501 as "unavailable".
    throw new HttpError(501, "skill search not supported");
  }
  const removeMatch = /^\/skills\/(.+)$/.exec(path);
  if (removeMatch && method === "DELETE") {
    return handleSkillsRemove(decodeURIComponent(removeMatch[1]!), res, deps);
  }
  throw new HttpError(405, "method not allowed");
}
