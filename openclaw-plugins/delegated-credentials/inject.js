// Pure, dependency-free logic for the delegated-credentials plugin, split out
// from index.js so it can be unit-tested without loading the OpenClaw SDK.
//
// None of this logs anything — the caller must keep the secret VALUES out of the
// logs; here they only ever flow into the returned tool params.

/**
 * The agent `exec` tool is the one that spawns skill subprocesses (e.g.
 * `python3 scripts/sportslink.py`), and it is the only tool that takes an `env`
 * parameter. We inject delegated creds ONLY into that tool; every other tool is
 * left untouched (an unexpected `env` param could be rejected or ignored).
 * `system_run` is accepted as a defensive alias for the same host-exec surface.
 */
const EXEC_TOOL_NAMES = new Set(["exec", "system_run"]);

/** True when `toolName` is the host-exec tool that accepts an `env` param. */
export function isExecTool(toolName) {
  return typeof toolName === "string" && EXEC_TOOL_NAMES.has(toolName);
}

/** Valid env var names — mirrors the shim-side filter so nothing odd is injected
 *  even if the broker returns a surprising key. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Merge delegated creds into a COPY of the exec tool's `params.env` and return
 * the new params object, or `null` when there is nothing to inject (so the
 * caller returns void = "no change" to OpenClaw).
 *
 * Rules:
 *   - Only string values under valid env-var-name keys are considered.
 *   - An env value the caller already set wins over a delegated cred on a key
 *     clash — an explicit per-call `env` is never silently overridden.
 *   - The input params object is not mutated.
 */
export function buildInjectedParams(params, creds) {
  if (!creds || typeof creds !== "object" || Array.isArray(creds)) return null;
  const keys = Object.keys(creds).filter(
    (k) => ENV_KEY_RE.test(k) && typeof creds[k] === "string",
  );
  if (keys.length === 0) return null;

  const base = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  const existingEnv =
    base.env && typeof base.env === "object" && !Array.isArray(base.env) ? base.env : {};
  const mergedEnv = { ...existingEnv };
  for (const k of keys) {
    if (!(k in mergedEnv)) mergedEnv[k] = creds[k];
  }
  return { ...base, env: mergedEnv };
}

/**
 * Extract the `{ credentials: {...} }` map from the loopback route's JSON body.
 * Returns `{}` for any unexpected shape. Never throws.
 */
export function parseCredentialsResponse(body) {
  const creds =
    body && typeof body === "object" && !Array.isArray(body) ? body.credentials : null;
  if (!creds || typeof creds !== "object" || Array.isArray(creds)) return {};
  return creds;
}
