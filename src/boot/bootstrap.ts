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
import { assembleSystemPrompt } from "../prompt/assemble.js";
import {
  defaultBasePrompt,
  defaultIdentity,
  loadPromptBlobs,
  renderWorkspace,
} from "../provision/render-workspace.js";
import { ClawhubSkillResolver } from "../skills/clawhub.js";
import { installBundleSkills } from "../skills/install.js";
import { LocalSkillResolver } from "../skills/local.js";
import type { InstalledSkill, SkillResolver } from "../skills/resolver.js";

/**
 * Boot pipeline:
 *
 *   1. Fetch the agent's bundle via the platform MCP (`get_my_bundle`).
 *      Empty / no-MCP-configured is OK — the agent still boots as a
 *      vanilla openclaw vessel.
 *   2. Install every declared skill into `workspace/skills/`. Two
 *      capabilities requiring the same skill at different versions is a
 *      fatal error (SkillVersionConflictError).
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
}

export async function bootstrap(env: AgentEnv): Promise<BootstrapResult> {
  const bundle = await fetchBundle(env);
  const blobs = await loadPromptBlobs(env);

  const workspaceSkillsDir = join(env.OPENCLAW_STATE_DIR, "workspace", "skills");
  const resolver = buildSkillResolver();

  let installedSkills: InstalledSkill[] = [];
  if (bundle) {
    installedSkills = await installBundleSkills(bundle, workspaceSkillsDir, resolver);
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

  const systemPrompt = assembleSystemPrompt({
    base: blobs.base ?? defaultBasePrompt(env),
    identity: blobs.identity ?? defaultIdentity(env),
    bundle,
  });
  await renderWorkspace({ env, assembledSoul: systemPrompt, blobs });

  log.info("bootstrap complete", {
    assignments: bundle?.assignments.length ?? 0,
    skills_installed: installedSkills.length,
    base_from_storage: blobs.base != null,
  });

  return { bundle, installedSkills, systemPrompt };
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

function buildSkillResolver(): SkillResolver {
  // SKILLS_DIR is where the image (or a future Storage pull step) stages
  // pre-built skill bundles. Defaults to ~/.openclaw-skills which is
  // baked into the agent-core image at build time.
  const sourceDir = process.env.SKILLS_DIR ?? "/home/agent/.openclaw-skills";
  const local = new LocalSkillResolver(sourceDir);
  return new ClawhubSkillResolver(local);
}
