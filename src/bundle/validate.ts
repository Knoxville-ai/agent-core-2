import { log } from "../log.js";
import type { AgentBundle, EnvVarSpec } from "./types.js";

/**
 * Boot-time validation: every `required: true` envVarSpec across every
 * assigned capability must have a non-empty value in `process.env` under
 * its alias (which is locked to the spec's `key` for capability bindings).
 *
 * Fails loud — throws with every missing alias listed. We do NOT
 * partially boot with degraded capabilities; an under-credentialed agent
 * is worse than a crashed one because it silently 500s on user turns.
 */

export interface EnvValidationResult {
  ok: true;
}

export interface MissingEnvVar {
  capability: string;
  listing: string;
  key: string;
  label: string;
  bound: boolean;
}

export class BundleEnvValidationError extends Error {
  constructor(public readonly missing: MissingEnvVar[]) {
    const lines = missing
      .map(
        (m) =>
          `  - ${m.key} (${m.label}) — capability "${m.capability}" in "${m.listing}"` +
          (m.bound ? "" : " [no credential bound on console side]"),
      )
      .join("\n");
    super(
      `Bundle env validation failed — ${missing.length} required env var(s) missing:\n${lines}`,
    );
    this.name = "BundleEnvValidationError";
  }
}

export function validateBundleEnv(
  bundle: AgentBundle,
  env: NodeJS.ProcessEnv = process.env,
): EnvValidationResult {
  const missing: MissingEnvVar[] = [];
  for (const a of bundle.assignments) {
    for (const spec of a.capability.envVarSpecs ?? []) {
      if (!spec.required) continue;
      const alias = aliasForSpec(spec);
      const value = env[alias];
      if (value && value.trim() !== "") continue;
      missing.push({
        capability: a.capability.name,
        listing: a.listing.slug,
        key: alias,
        label: spec.label,
        bound: Boolean(spec.boundCredentialId),
      });
    }
  }
  if (missing.length > 0) {
    throw new BundleEnvValidationError(missing);
  }
  return { ok: true };
}

function aliasForSpec(spec: EnvVarSpec): string {
  const alias = spec.boundEnvKeyAlias && spec.boundEnvKeyAlias.trim();
  return alias && alias !== "" ? alias : spec.key;
}

/** Best-effort "what got wired" log — secrets are NEVER logged, only the
 *  alias + bound credential label (which is operator-supplied metadata). */
export function logResolvedEnv(bundle: AgentBundle): void {
  for (const a of bundle.assignments) {
    for (const spec of a.capability.envVarSpecs ?? []) {
      const alias = aliasForSpec(spec);
      const present = Boolean(process.env[alias]);
      log.info("bundle env spec", {
        listing: a.listing.slug,
        capability: a.capability.name,
        key: alias,
        required: spec.required,
        secret: spec.secret,
        present,
        credential: spec.boundCredentialLabel ?? null,
      });
    }
  }
}
