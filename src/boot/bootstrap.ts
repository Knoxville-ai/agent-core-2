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
import {
  defaultIdentity,
  loadConstitution,
  loadPromptBlobs,
  renderWorkspace,
  writeOpenclawConfig,
} from "../provision/render-workspace.js";
import { loadBootListSkills } from "../skills/boot-list.js";
import { EMPTY_TOOL_POLICY, loadToolPolicy } from "../skills/tool-policy.js";
import { ClawhubSkillResolver } from "../skills/clawhub.js";
import { provisionSkillDeps } from "../skills/deps.js";
import {
  installBootListSkills,
  installBundleSkills,
  resetWorkspaceSkills,
} from "../skills/install.js";
import type { InstalledSkill, SkillResolver } from "../skills/resolver.js";

/**
 * Boot pipeline:
 *
 *   1. Fetch the agent's bundle via the platform MCP (`get_my_bundle`).
 *      Empty / no-MCP-configured is OK — the agent still boots as a
 *      vanilla openclaw vessel.
 *   2. Write a valid openclaw.json, then install every declared skill into
 *      `workspace/skills/` (the install CLI validates the config, so it must be
 *      current first). Two capabilities requiring the same skill at different
 *      versions is a fatal error (SkillVersionConflictError).
 *   3. Validate every `required: true` envVarSpec is present in
 *      process.env under its alias. Fail loud with every missing key.
 *   4. Assemble SOUL.md: base prompt + identity + per-capability fragments.
 *   5. Render the workspace + openclaw.json against the assembled prompt.
 *
 * Returns the bundle + installed skills so `manifest.ts` (or whatever
 * downstream consumer) can record what shipped this boot.
 */

export interface BootstrapResult {
  bundle: AgentBundle | null;
  installedSkills: InstalledSkill[];
  systemPrompt: string;
  /** The agent-owned memory checkpoint, restored during boot. Returned so
   *  index.ts reuses this exact instance for the shim + SIGTERM flush instead
   *  of constructing a second one (which would double-restore). */
  memory: MemoryCheckpoint;
}

export async function bootstrap(env: AgentEnv): Promise<BootstrapResult> {
  const bundle = await fetchBundle(env);
  const blobs = await loadPromptBlobs(env);
  const constitution = await loadConstitution(env);

  const workspaceSkillsDir = join(env.OPENCLAW_STATE_DIR, "workspace", "skills");

  // Reconcile skills from scratch every boot: wipe once, then install from the
  // two authoritative sources — the drive-through bundle AND the console-managed
  // boot list (config/skills.json). Anything in neither is intentionally not
  // persisted (no stale-skill drift). The single wipe here is shared so the
  // boot-list install doesn't clobber the bundle install and vice-versa.
  await resetWorkspaceSkills(workspaceSkillsDir);

  // Write a valid openclaw.json BEFORE installing any skill. Skill installs
  // shell out to `openclaw skills install`, whose CLI loads + validates the
  // config and refuses to run against an invalid one. On a boot that follows a
  // failed one — e.g. a since-fixed bad provider block, or a model switch — the
  // on-disk openclaw.json is stale/invalid until renderWorkspace rewrites it at
  // the end of boot, which would be too late: every skill install would fail
  // and the agent would come up with no skills. renderWorkspace writes the same
  // file again later; buildOpenclawConfig is pure so the bytes are identical.
  // Console-managed per-agent tool policy. Loaded BEFORE the config is written
  // because a non-empty allowlist changes which tools the skill-install CLI
  // itself sees. Soft-fails to an empty policy: a Storage hiccup must not brick
  // a boot, and an empty policy is exactly today's behaviour.
  const toolPolicy = await loadToolPolicy(env).catch((err) => {
    log.warn("tool policy load failed; continuing with none", { err: String(err) });
    return EMPTY_TOOL_POLICY;
  });

  await writeOpenclawConfig(env, toolPolicy);

  let installedSkills: InstalledSkill[] = [];
  if (bundle) {
    installedSkills = await installBundleSkills(bundle, workspaceSkillsDir, resolver(env));
    try {
      validateBundleEnv(bundle);
    } catch (err) {
      if (err instanceof BundleEnvValidationError) {
        // Log every missing key BEFORE throwing so operators can see the
        // full picture from the crash log even if the stack trace is
        // truncated by their log pipeline.
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
  await provisionSkillDeps(installedSkills);

  // Restore agent-owned memory (playbook.md + notes/) with volume-wins
  // precedence BEFORE assembling SOUL, so the current playbook can be folded
  // into the `# PLAYBOOK` section. This runs after the skills reset above (which
  // only touches workspace/skills/) and never touches the console-authored
  // prompts. index.ts reuses this instance — see BootstrapResult.memory.
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
  await renderWorkspace({ env, assembledSoul: systemPrompt, blobs, toolPolicy });

  log.info("bootstrap complete", {
    assignments: bundle?.assignments.length ?? 0,
    skills_installed: installedSkills.length,
    charter_from_storage: blobs.base != null,
    identity_from_storage: blobs.identity != null,
    operator_notes: blobs.playbookSeed != null,
    memory_digest: memoryDigest != null,
    playbook: playbook != null,
  });

  return { bundle, installedSkills, systemPrompt, memory };
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
