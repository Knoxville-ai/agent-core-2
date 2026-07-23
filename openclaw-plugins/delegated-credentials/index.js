import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { buildInjectedParams, isExecTool, parseCredentialsResponse } from "./inject.js";

/**
 * Redacted, one-line proof that an injection happened — key NAMES + count +
 * session key, NEVER values. This mirrors the shim's "delegated credentials
 * staged for turn" log and is what makes this otherwise-silent plugin
 * debuggable: seeing this line on a delegated turn confirms the credential
 * actually reached the exec env (vs. the skill's own auth error meaning it
 * did not). Logging names is compliant with the "never log the values" rule
 * (the shim already logs `credentialKeyNames`).
 */
function logInjection(sessionKey, creds) {
  try {
    const names = Object.keys(creds ?? {}).sort();
    // stderr so it lands in the gateway log stream regardless of stdout capture.
    console.error(
      `[knox-delegated-credentials] injected ${names.length} credential(s) ` +
        `into exec env for session ${sessionKey}: [${names.join(", ")}]`,
    );
  } catch {
    /* never let logging break the tool call */
  }
}

/**
 * Knox delegated-credentials injector — the OpenClaw half of the platform-brokered
 * A2A credential consumer.
 *
 * On a delegated (agent-to-agent) turn, the agent-core shim pulls the credentials
 * the calling agent shared for that turn and stashes them keyed by the OpenClaw
 * session key. This plugin runs on `before_tool_call`: for the `exec` tool on a
 * session that has creds staged, it merges them into `params.env`, so the skill
 * subprocess reads e.g. `SPORTSINC_API_KEY` from its environment exactly as it
 * would standalone.
 *
 * Boundaries this plugin keeps:
 *   - The secrets travel shim -> plugin over a LOOPBACK route, gateway-token
 *     authed. They never enter the model prompt, the tool-call the model emitted,
 *     or the transcript (this hook rewrites tool *execution* params only).
 *   - Nothing is logged (the response holds secrets).
 *   - Fail-open: on any error we inject nothing and never block the tool; the
 *     skill surfaces its own auth error.
 *   - Per-session isolation: creds are looked up by `ctx.sessionKey`, so a turn
 *     only ever sees its own delegation's creds. A non-delegated session gets an
 *     empty map back and nothing is injected.
 */

const SHIM_PORT = process.env.AGENT_HTTP_PORT || "8080";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const LOOKUP_URL = `http://127.0.0.1:${SHIM_PORT}/internal/delegated-credentials`;
const FETCH_TIMEOUT_MS = 2000;

// Memoize per (sessionKey, runId) so we hit the shim at most once per turn rather
// than on every exec call. Short TTL backstop keeps the map from growing and
// bounds staleness; a turn's exec calls all happen inside one TTL window.
const CACHE_TTL_MS = 5000;
const cache = new Map();

async function fetchDelegatedCreds(sessionKey, runId) {
  if (!sessionKey || !GATEWAY_TOKEN) return {};
  const cacheKey = `${sessionKey}::${runId ?? ""}`;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > now) return hit.creds;

  let creds = {};
  try {
    const url = `${LOOKUP_URL}?session_key=${encodeURIComponent(sessionKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      creds = parseCredentialsResponse(await res.json());
    }
  } catch {
    // Fail open — no delegated creds this call. NEVER log the response body.
    creds = {};
  }
  cache.set(cacheKey, { creds, expiresAt: now + CACHE_TTL_MS });
  return creds;
}

export default definePluginEntry({
  id: "knox-delegated-credentials",
  name: "Knox Delegated Credentials",
  description:
    "Inject platform-brokered delegated credentials into the exec tool env for agent-to-agent turns.",
  register(api) {
    api.on(
      "before_tool_call",
      async (event, ctx) => {
        if (!isExecTool(event?.toolName)) return;
        const sessionKey = ctx?.sessionKey;
        if (!sessionKey) return;
        const creds = await fetchDelegatedCreds(sessionKey, ctx?.runId ?? event?.runId);
        const params = buildInjectedParams(event?.params ?? {}, creds);
        if (!params) return; // nothing to inject -> no change to the tool call
        logInjection(sessionKey, creds);
        return { params };
      },
      { priority: 40 },
    );
  },
});
