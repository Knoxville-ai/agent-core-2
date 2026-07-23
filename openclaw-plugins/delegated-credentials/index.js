import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { buildInjectedParams, isExecTool, parseCredentialsResponse } from "./inject.js";

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
 *   - NEVER logs the secret VALUES. It DOES log a redacted diagnostic (session
 *     key, fetch status, and credential NAMES) so a delegated turn is traceable
 *     end-to-end — the same names-only rule the shim's staging log follows.
 *   - Fail-open: on any error we inject nothing and never block the tool; the
 *     skill surfaces its own auth error.
 *   - Per-session isolation: creds are looked up by `ctx.sessionKey`, so a turn
 *     only ever sees its own delegation's creds. A non-delegated session gets an
 *     empty map back and nothing is injected.
 */

const FETCH_TIMEOUT_MS = 2000;

// Read the loopback port + gateway token at CALL time, not module-load time.
// OpenClaw loads this plugin in more than one context during a run; capturing
// `process.env` at import time risks binding an empty token in a realm that was
// evaluated before the env was populated. Reading lazily always sees the live
// process env of whatever realm the hook fires in.
function loopbackConfig() {
  const port = process.env.AGENT_HTTP_PORT || "8080";
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || "";
  return { port, token, url: `http://127.0.0.1:${port}/internal/delegated-credentials` };
}

// Memoize per (sessionKey, runId) so we hit the shim at most once per turn rather
// than on every exec call. Short TTL backstop keeps the map from growing and
// bounds staleness; a turn's exec calls all happen inside one TTL window.
const CACHE_TTL_MS = 5000;
const cache = new Map();

/**
 * One redacted, end-to-end-traceable diagnostic line per delegated exec — so a
 * turn that fails to inject can be pinpointed (token missing? loopback 401? empty
 * store? session-key mismatch?) without ever exposing a value. Gated to `a2a:`
 * sessions to avoid noise on ordinary web-chat exec calls. NEVER logs values.
 */
function logDiag(sessionKey, diag, creds) {
  try {
    // Skip ordinary web-chat exec calls (the common, uninteresting case). Log
    // everything else — including a missing/odd session key, which is itself the
    // anomaly worth seeing (e.g. ctx.sessionKey not populated for the hook).
    if (typeof sessionKey === "string" && sessionKey.startsWith("webchat:")) return;
    const names = Object.keys(creds ?? {}).sort();
    console.error(
      `[knox-delegated-credentials] exec hook session=${sessionKey ?? "undefined"} ` +
        `tokenSet=${diag.tokenSet} port=${diag.port} status=${diag.status} ` +
        `creds=${names.length} keys=[${names.join(", ")}]`,
    );
  } catch {
    /* never let logging break the tool call */
  }
}

/** Fetch this turn's staged creds from the shim's loopback route. Returns
 *  `{ creds, diag }` where `diag` is non-secret fetch telemetry for logging. */
async function fetchDelegatedCreds(sessionKey, runId) {
  const { port, token, url: lookupUrl } = loopbackConfig();
  if (!sessionKey || !token) {
    return { creds: {}, diag: { tokenSet: Boolean(token), port, status: "skipped" } };
  }
  const cacheKey = `${sessionKey}::${runId ?? ""}`;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > now) {
    return { creds: hit.creds, diag: { tokenSet: true, port, status: "cache" } };
  }

  let creds = {};
  let status = "error";
  try {
    const url = `${lookupUrl}?session_key=${encodeURIComponent(sessionKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    status = String(res.status);
    if (res.ok) {
      creds = parseCredentialsResponse(await res.json());
    }
  } catch (err) {
    // Fail open — no delegated creds this call. NEVER log the response body.
    status = `fetch_error:${err?.name || "unknown"}`;
    creds = {};
  }
  cache.set(cacheKey, { creds, expiresAt: now + CACHE_TTL_MS });
  return { creds, diag: { tokenSet: true, port, status } };
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
        const { creds, diag } = await fetchDelegatedCreds(
          sessionKey,
          ctx?.runId ?? event?.runId,
        );
        // Redacted trace of what this exec saw (names + status only, no values).
        logDiag(sessionKey, diag, creds);
        if (!sessionKey) return;
        const params = buildInjectedParams(event?.params ?? {}, creds);
        if (!params) return; // nothing to inject -> no change to the tool call
        return { params };
      },
      { priority: 40 },
    );
  },
});
