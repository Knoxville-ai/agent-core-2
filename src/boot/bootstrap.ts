import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { bundleClientFromEnv } from "../bundle/client.js";
import {
  BundleEnvValidationError,
  logResolvedEnv,
  validateBundleEnv,
} from "../bundle/validate.js";
import type { AgentBundle } from "../bundle/types.js";
import type { AgentEnv } from "../env.js";
import { log } from "../log.js";
import { assembleSystemPrompt, parseEscalatedTools } from "../prompt/assemble.js";
import { MemoryCheckpoint } from "../provision/agent-memory.js";
import { fetchPinnableModelIds } from "../provision/pinnable-models.js";
import {
  defaultIdentity,
  loadConstitution,
  loadPromptBlobs,
  renderWorkspace,
  writeOpenclawConfig,
} from "../provision/render-workspace.js";
import { loadBootListSkills } from "../skills/boot-list.js";
import { ClawhubSkillResolver } from "../skills/clawhub.js";
import { provisionSkillDeps } from "../skills/deps.js";
import {
  installBootListSkills,
  installBundleSkills,
  resetWorkspaceSkills,
} from "../skills/install.js";
import { clearLock, readLock } from "../skills/lock.js";
import type { InstalledSkill, SkillResolver } from "../skills/resolver.js";
import type { SkillSync } from "../skills/sync.js";

/**
 * Boot pipeline:
 *
 *   1. Fetch the agent's bundle via the platform MCP (`get_my_bundle`).
 *      Empty / no-MCP-configured is OK — the agent still boots as a
 *      vanilla openclaw vessel.
 *   2. Write a valid openclaw.json (every openclaw CLI call validates it), then
 *      bring `workspace/skills/` to the desired state:
 *        - library mode (the console serves `get_skill_sync_plan`): SkillSync
 *          reconciles against the lock on the volume — no wipe; only what
 *          changed is fetched. If the plan can't be fetched, the last-known-good
 *          set stays and boot continues, unless a capability skill has nothing
 *          installed at all (fail loud, as before).
 *        - legacy mode (an older console, or no platform MCP): wipe, then
 *          install the bundle's ClawHub skills (fail loud; two capabilities
 *          pinning one skill differently is SkillVersionConflictError) and the
 *          console boot list (`config/skills.json`, soft-fail), then their deps.
 *   3. Validate every `required: true` envVarSpec is present in
 *      process.env under its alias. Fail loud with every missing key.
 *   4. Assemble SOUL.md: base prompt + identity + per-capability fragments.
 *   5. Render the workspace + openclaw.json against the assembled prompt; the
 *      config carries the lock's `skills.entries` revs.
 *
 * Returns the bundle + installed skills so `manifest.ts` (or whatever
 * downstream consumer) can record what shipped this boot.
 */

export interface BootstrapOptions {
  /** The vessel's SkillSync (null/omitted when the platform MCP isn't
   *  configured — the legacy path is then the only one). index.ts keeps using
   *  the same instance for the /skills/sync route and the background poll. */
  skillSync?: SkillSync | null;
}

/** A capability's skill has nothing on disk and the plan couldn't be fetched. */
export class RequiredSkillsUnavailableError extends Error {
  constructor(
    public readonly refs: string[],
    cause: string,
  ) {
    super(
      `Required capability skill(s) ${refs.join(", ")} are not installed and the skills plan ` +
        `could not be fetched (${cause}). Boot can't continue without them; it will retry on restart.`,
    );
    this.name = "RequiredSkillsUnavailableError";
  }
}

export interface BootstrapResult {
  bundle: AgentBundle | null;
  installedSkills: InstalledSkill[];
  /** Which path installed the skills this boot. */
  skillsMode: "library" | "legacy";
  systemPrompt: string;
  /** The agent-owned memory checkpoint, restored during boot. Returned so
   *  index.ts reuses this exact instance for the shim + SIGTERM flush instead
   *  of constructing a second one (which would double-restore). */
  memory: MemoryCheckpoint;
}

export async function bootstrap(
  env: AgentEnv,
  opts: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const bundle = await fetchBundle(env);
  const blobs = await loadPromptBlobs(env);
  const constitution = await loadConstitution(env);

  // Models this agent's routines can pin via a per-request override, so both
  // openclaw.json writes below overlay them with the prompt-cache-key compat
  // flag and their turns stay cost-tracked (see pinnable-models.ts). Fail-open
  // to [] — never blocks boot. Fetched once and passed to BOTH writes.
  const extraModelIds = await fetchPinnableModelIds(env);

  const workspaceSkillsDir = join(env.OPENCLAW_STATE_DIR, "workspace", "skills");

  // Write a valid openclaw.json BEFORE any skill work. Skill installs (ClawHub)
  // and the eligibility check shell out to the openclaw CLI, which loads +
  // validates the config and refuses to run against an invalid one. On a boot
  // that follows a failed one — e.g. a since-fixed bad provider block, or a
  // model switch — the on-disk openclaw.json is stale/invalid until
  // renderWorkspace rewrites it at the end of boot, which would be too late.
  // renderWorkspace writes it again with the post-reconcile lock's revs.
  await writeOpenclawConfig(env, extraModelIds);

  const sync = opts.skillSync ?? null;
  const outcome = sync ? await sync.reconcile("boot") : null;
  let installedSkills: InstalledSkill[] = [];
  let skillsMode: "library" | "legacy" = "legacy";

  if (sync && outcome && outcome.status !== "legacy") {
    // ── Library mode: SkillSync owns workspace/skills/ ──────────────────────
    skillsMode = "library";
    if (outcome.status === "error") {
      // The plan couldn't be fetched: the last-known-good folders from the lock
      // keep running and the poll retries. Keep the fail-loud posture for
      // capability skills only when there is genuinely nothing to run.
      const missing = await sync.missingRequiredSkills(requiredSkillRefs(bundle));
      if (missing.length > 0) {
        throw new RequiredSkillsUnavailableError(missing, outcome.error ?? "unknown error");
      }
      log.warn("skills plan unavailable at boot; running the last-known-good skills", {
        err: outcome.error,
      });
    }
    installedSkills = await lockedSkills(env.OPENCLAW_STATE_DIR, workspaceSkillsDir);
    if (bundle) validateAndLogBundleEnv(bundle);
  } else {
    // ── Legacy mode: an older console (no skills library) or no platform MCP.
    // The lock no longer describes skills/ once the wipe below runs.
    if (sync) await sync.resetForLegacy();
    else await clearLock(env.OPENCLAW_STATE_DIR);

    // Reconcile skills from scratch every boot: wipe once, then install from the
    // two authoritative sources — the drive-through bundle AND the console-managed
    // boot list (config/skills.json). Anything in neither is intentionally not
    // persisted (no stale-skill drift). The single wipe here is shared so the
    // boot-list install doesn't clobber the bundle install and vice-versa.
    await resetWorkspaceSkills(workspaceSkillsDir);

    if (bundle) {
      installedSkills = await installBundleSkills(bundle, workspaceSkillsDir, resolver(env));
      validateAndLogBundleEnv(bundle);
    }

    // Console-managed boot list — the durable per-agent skill list the console's
    // agent-skills UI writes to Storage. Additive + soft-fail so a console-added
    // skill survives restarts without one bad slug bricking the agent. Skips refs
    // the bundle already pinned.
    const bootListReqs = await loadBootListSkills(env);
    const bootInstalled = await installBootListSkills(
      bootListReqs,
      workspaceSkillsDir,
      resolver(env),
      { skip: new Set(installedSkills.map((s) => s.ref)) },
    );
    installedSkills = [...installedSkills, ...bootInstalled];

    // Install each installed skill's declared Python deps (SKILL.md →
    // metadata.openclaw.install.uv) into the interpreter the agent shells out to,
    // plus the Playwright Chromium build for any browser skill. Runs before the
    // gateway spawns any skill so `python3 scripts/foo.py` finds its imports.
    // Soft-fail so a dep hiccup degrades one skill rather than bricking boot.
    // (Library mode does this per skill, before activation, inside SkillSync.)
    await provisionSkillDeps(installedSkills);
  }

  // Restore agent-owned memory (playbook.md + notes/) with volume-wins
  // precedence BEFORE assembling SOUL, so the current playbook can be folded
  // into the `# PLAYBOOK` section. This runs after the skills work above (which
  // only touches workspace/skills/ and its scratch dirs) and never touches the
  // console-authored prompts. index.ts reuses this instance — see
  // BootstrapResult.memory.
  const memory = MemoryCheckpoint.fromEnv(env);
  await memory.restore();
  const playbook = await readFileOrNull(
    join(env.OPENCLAW_STATE_DIR, "workspace", "playbook.md"),
  );

  // Boot digest of the agent's durable memories (Postgres, via the platform
  // `recall` tool). Fail-open: on any error the `# MEMORY` section is omitted
  // and boot proceeds — the volume/Storage layers are unaffected.
  const memoryDigest = await fetchMemoryDigest(env);

  const systemPrompt = assembleSystemPrompt({
    constitution,
    identity: blobs.identity ?? defaultIdentity(env),
    charter: blobs.base,
    bundle,
    operatorNotes: blobs.playbookSeed,
    memoryDigest,
    playbook,
    escalatedTools: parseEscalatedTools(env.OPENCLAW_TOOLS_ESCALATE),
  });
  await renderWorkspace({ env, assembledSoul: systemPrompt, blobs, extraModelIds });

  log.info("bootstrap complete", {
    assignments: bundle?.assignments.length ?? 0,
    skills_mode: skillsMode,
    skills_installed: installedSkills.length,
    charter_from_storage: blobs.base != null,
    identity_from_storage: blobs.identity != null,
    operator_notes: blobs.playbookSeed != null,
    memory_digest: memoryDigest != null,
    playbook: playbook != null,
  });

  return { bundle, installedSkills, skillsMode, systemPrompt, memory };
}

/** Validate the bundle's required env (fail loud), logging every missing key
 *  BEFORE throwing so operators see the full picture even if the stack trace is
 *  truncated by their log pipeline. Then log what got wired. */
function validateAndLogBundleEnv(bundle: AgentBundle): void {
  try {
    validateBundleEnv(bundle);
  } catch (err) {
    if (err instanceof BundleEnvValidationError) {
      for (const m of err.missing) {
        log.error("bundle env missing", {
          key: m.key,
          label: m.label,
          capability: m.capability,
          listing: m.listing,
          bound_on_console: m.bound,
        });
      }
    }
    throw err;
  }
  logResolvedEnv(bundle);
}

/** Every capability's skill ref (a ClawHub slug or a library skill id). */
export function requiredSkillRefs(bundle: AgentBundle | null): string[] {
  if (!bundle) return [];
  const refs = new Set<string>();
  for (const a of bundle.assignments) {
    const ref = a.capability.skill?.ref;
    if (ref) refs.add(ref);
  }
  return [...refs].sort();
}

/** The lock's skills as InstalledSkill records (boot summary + logging). */
async function lockedSkills(stateDir: string, skillsDir: string): Promise<InstalledSkill[]> {
  const { lock } = await readLock(stateDir);
  return Object.entries(lock.skills).map(([slug, e]) => ({
    ref: slug,
    version: e.version ?? "",
    path: join(skillsDir, slug),
    source: e.source,
  }));
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Boot digest of durable memories via the platform `recall` tool. Returns null
 *  when the platform MCP isn't wired or on any error (fail-open). */
async function fetchMemoryDigest(env: AgentEnv): Promise<string | null> {
  const client = bundleClientFromEnv(env);
  if (!client) return null;
  try {
    return await client.fetchMemoryDigest();
  } catch (err) {
    log.warn("memory digest fetch failed; booting without # MEMORY", {
      err: String(err),
    });
    return null;
  }
}

async function fetchBundle(env: AgentEnv): Promise<AgentBundle | null> {
  const client = bundleClientFromEnv(env);
  if (!client) return null;
  try {
    const bundle = await client.fetchBundle();
    log.info("bundle fetched", {
      agent: bundle.agent.uid,
      assignments: bundle.assignments.length,
      skills: bundle.assignments
        .map((a) => a.capability.skill)
        .filter((s) => s !== null && s !== undefined)
        .map((s) => `${s!.ref}@${s!.version}`),
    });
    return bundle;
  } catch (err) {
    // A misconfigured MCP URL is a fatal config error — the agent would
    // otherwise silently boot without any of its capabilities. Treat as
    // fail-loud (consistent with missing env vars).
    log.error("bundle fetch failed", { err: String(err) });
    throw err;
  }
}

function resolver(env: AgentEnv): SkillResolver {
  return new ClawhubSkillResolver({ stateDir: env.OPENCLAW_STATE_DIR });
}
