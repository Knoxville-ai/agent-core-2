import { readdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import type { GatewayProcess } from "../openclaw/gateway-process.js";
import { ClawhubSkillResolver } from "../skills/clawhub.js";
import { provisionSkillDeps } from "../skills/deps.js";
import { HttpError } from "./auth.js";
import { readJsonBody, sendJson } from "./util.js";

/**
 * Live skill management surface, gateway-token authed (same operator capability
 * as `/files/*`; the console server holds OPENCLAW_GATEWAY_TOKEN, never a
 * browser). Lets the console install/remove skills into a RUNNING agent without
 * a Railway redeploy — the durable half is `config/skills.json` (installed at
 * boot), this is the live half.
 *
 *   GET    /skills            -> { skills: LiveSkill[] }
 *   POST   /skills/install    -> { ok, skill }  ; body { slug, version? }
 *   DELETE /skills/{slug}     -> { ok }
 *   (GET   /skills/search     -> 501; registry search isn't wired — the console
 *                                treats 501 as "search unavailable", not error.)
 *
 * After an install/remove we restart the openclaw gateway child in place (the
 * same reload used after a model-OAuth change) so it re-reads workspace/skills/.
 * This is a ~seconds in-process reload, NOT a container restart: the shim stays
 * up, the volume stays mounted. Any in-flight message stream is interrupted, so
 * this is an operator action, not something to fire mid-conversation.
 */

const SLUG_RE = /^[a-zA-Z0-9@._/-]+$/;
const VERSION_RE = /^[a-zA-Z0-9._-]+$/;

function skillsRoot(env: AgentEnv): string {
  return join(env.OPENCLAW_STATE_DIR, "workspace", "skills");
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

export async function handleSkillsList(res: ServerResponse, env: AgentEnv): Promise<void> {
  let names: string[] = [];
  try {
    const entries = await readdir(skillsRoot(env), { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // Dir absent (nothing installed yet) → empty list, not an error.
    names = [];
  }
  // Version is best-effort null here; the console pairs this with the boot list
  // (config/skills.json) which carries the pinned versions.
  const skills = names.map((slug) => ({ slug, version: null, source: "clawhub" as const }));
  sendJson(res, 200, { skills });
}

interface InstallBody {
  slug?: unknown;
  version?: unknown;
}

export async function handleSkillsInstall(
  req: IncomingMessage,
  res: ServerResponse,
  env: AgentEnv,
  gateway: GatewayProcess,
): Promise<void> {
  const body = (await readJsonBody<InstallBody>(req)) ?? {};
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const version =
    typeof body.version === "string" && body.version.trim() !== ""
      ? body.version.trim()
      : "";
  if (!slug || !SLUG_RE.test(slug)) throw new HttpError(400, "invalid slug");
  if (version && !VERSION_RE.test(version)) throw new HttpError(400, "invalid version");

  const resolver = new ClawhubSkillResolver({ stateDir: env.OPENCLAW_STATE_DIR });
  const installed = await resolver.install(
    { source: "clawhub", ref: slug, version },
    skillsRoot(env),
  );
  // Install the newly-added skill's declared Python deps (SKILL.md →
  // metadata.openclaw.install.uv) into the agent's interpreter before the
  // gateway reload picks the skill up, so a `python3 scripts/foo.py` invocation
  // doesn't fail with ModuleNotFoundError on first use.
  await provisionSkillDeps([installed]);
  // Reload the running gateway so the skill is usable immediately.
  await gateway.restart();
  log.info("live skill installed", { slug, version: version || "(latest)" });
  sendJson(res, 200, {
    ok: true,
    skill: { slug, version: version || null, source: installed.source },
  });
}

export async function handleSkillsRemove(
  slug: string,
  res: ServerResponse,
  env: AgentEnv,
  gateway: GatewayProcess,
): Promise<void> {
  const dir = safeSkillDir(skillsRoot(env), slug);
  if (!dir) throw new HttpError(400, "invalid slug");
  await rm(dir, { recursive: true, force: true });
  // Reload so the gateway drops the removed skill from its registry.
  await gateway.restart();
  log.info("live skill removed", { slug });
  sendJson(res, 200, { ok: true });
}
