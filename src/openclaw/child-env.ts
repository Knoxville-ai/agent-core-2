import { AGENT_ENV_KEYS } from "../env.js";

/**
 * The environment of every process the shim starts.
 *
 * The one that matters most is the openclaw gateway: openclaw builds each exec
 * tool command's environment from the gateway's own `process.env` (minus a
 * small host-env blocklist of its own), so whatever the gateway is started
 * with, every model-directed command sees too. The other children (`openclaw
 * skills check|install`, `openclaw voicecall speak`, the OAuth login PTY,
 * ollama, uv/pip) get the same treatment: while they run, their environment is
 * as readable to a same-uid process as the gateway's.
 *
 * The container's environment holds two kinds of variables:
 *
 *   - PLATFORM configuration: everything the vessel declares in ../env.ts, the
 *     few platform names it does not (below), and the RAILWAY_ / PLATFORM_
 *     namespaces customers can never write. This part is an ALLOWLIST: a
 *     platform name reaches a child only if `CHILD_PLATFORM_ALLOW` lists it.
 *     A variable added to env.ts later is withheld until someone decides a
 *     child needs it.
 *
 *   - CUSTOMER variables: org credentials bound to the agent under an env
 *     alias, the Environment tab's values, phone-provider keys. Their names
 *     are chosen per agent, so they cannot be listed here; skills read them in
 *     exec (`requires.env`), and `openclaw skills check` must see the same set
 *     to judge eligibility. They pass through unchanged, except for names
 *     shaped like a database service secret (`PLATFORM_SECRET_PATTERNS`).
 *
 * Image/runtime variables (PATH, HOME, LANG, NODE_ENV, NPM_CONFIG_PREFIX,
 * PLAYWRIGHT_BROWSERS_PATH, U2NET_HOME, ...) are not platform secrets and pass
 * through like customer variables.
 */

/** Platform names the console or the image may set that env.ts does not declare. */
const EXTRA_PLATFORM_KEYS: readonly string[] = [
  // The console's name for the fleet database key; never meant for a container,
  // withheld in case an operator copies it onto one.
  "AGENT_SUPABASE_SECRET_KEY",
  // Model tab bookkeeping (which org credential LLM_API_KEY came from).
  "LLM_API_KEY_CREDENTIAL_ID",
  // Shim-only override of the gateway model route.
  "OPENCLAW_MODEL_ROUTE",
  // Set by the shim for the gateway alone (./gateway-auth.ts); never inherited.
  "KNOX_PLUGIN_TOKEN_FD",
  // Console-managed bearer policy flag.
  "AGENT_BEARER_POLICY",
];

/** Namespaces only the platform (or Railway) writes. */
const PLATFORM_PREFIXES: readonly string[] = ["RAILWAY_", "PLATFORM_"];

/** Name shapes of database service secrets. No customer variable needs one in
 *  a child process, and a platform one must never reach it under any name. */
const PLATFORM_SECRET_PATTERNS: readonly RegExp[] = [/SERVICE_ROLE/, /JWT_SECRET/];

/**
 * Platform variables a child process may keep, each because something running
 * there reads it:
 */
export const CHILD_PLATFORM_ALLOW: ReadonlySet<string> = new Set([
  // Loopback port of the shim, read by the knox openclaw plugins.
  "AGENT_HTTP_PORT",
  // The gateway's own port and state dir (also passed explicitly on spawn).
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_STATE_DIR",
  // Seed openclaw derives the model OAuth store's encryption key from; the
  // gateway and `openclaw models auth login` read it from their env.
  "OPENCLAW_AUTH_PROFILE_SECRET_KEY",
  // Non-secret identity, also stated in the agent's system prompt.
  "AGENT_UID",
  "AGENT_ORG",
  "AGENT_ROLE",
]);

const PLATFORM_KEYS: ReadonlySet<string> = new Set([...AGENT_ENV_KEYS, ...EXTRA_PLATFORM_KEYS]);

/** True when `name` must not be in a child process's environment. */
export function isWithheldFromChildren(name: string): boolean {
  if (CHILD_PLATFORM_ALLOW.has(name)) return false;
  if (PLATFORM_KEYS.has(name)) return true;
  const upper = name.toUpperCase();
  if (PLATFORM_PREFIXES.some((p) => upper.startsWith(p))) return true;
  return PLATFORM_SECRET_PATTERNS.some((re) => re.test(upper));
}

/**
 * `source` minus every withheld variable, plus `overrides` (applied last, so a
 * caller can set HOME/TMPDIR/etc. for the child). Overrides are trusted: they
 * are what the shim chooses to pass, not inherited state.
 */
export function childEnv(
  overrides: Record<string, string | undefined> = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || isWithheldFromChildren(name)) continue;
    out[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete out[name];
    else out[name] = value;
  }
  return out;
}

/** Names (never values) `childEnv` drops from `source` — for a boot log line. */
export function withheldNames(source: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(source)
    .filter((name) => source[name] !== undefined && isWithheldFromChildren(name))
    .sort();
}
