// Dependency-free logic for the knox-session-policy plugin, split out from
// index.js so it can be unit-tested without loading the OpenClaw SDK.

/** The runtime's session ticket on a platform tool call (src/shim/platform-mcp-forward.ts). */
export const SESSION_STAMP_PARAM = "_knox_session";

/** The phone step-up tool (src/shim/session-policy.ts VERIFY_CALLER_TOOL). */
export const VERIFY_CALLER_TOOL = "verify_caller_pin";

/** What the agent is told when the policy can't be asked. The call does not run. */
export const UNCHECKED_REASON =
  "This tool call couldn't be checked against the agent's tool policy just now, so it wasn't run. Try again shortly.";

/** True for a tool of the console's MCP server (`knoxville_platform__<tool>`). */
export function isPlatformTool(toolName) {
  return typeof toolName === "string" && toolName.toLowerCase().startsWith("knoxville_platform__");
}

/** True for a voice-call session key (`voice:…`, however it is prefixed). */
export function isVoiceSessionKey(sessionKey) {
  return typeof sessionKey === "string" && /(^|:)voice:/.test(sessionKey);
}

/**
 * Stamp the shim's session ticket onto a platform tool call's params IN
 * PLACE. openclaw hands every before_tool_call handler the same params object
 * and executes it (merged under any handler's returned params), so an
 * in-place stamp survives the other injectors that return their own copy. The
 * shim's platform MCP route takes it off before the call reaches the console.
 * Overwrites whatever the model put there; with no ticket, removes it.
 */
export function stampSession(params, ticket) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  if (typeof ticket !== "string" || !ticket) {
    delete params[SESSION_STAMP_PARAM];
    return false;
  }
  params[SESSION_STAMP_PARAM] = ticket;
  return true;
}

/**
 * The verdict to return to openclaw for the shim's answer (null = unreachable).
 * Fail-closed, unless the operator turned the session rules off
 * (AGENT_SESSION_TOOL_POLICY=off → `failOpen`), the kill switch for a gateway
 * whose loopback token never arrived.
 */
export function hookResult(answer, { failOpen = false } = {}) {
  if (!answer || typeof answer !== "object") {
    return failOpen ? undefined : { block: true, blockReason: UNCHECKED_REASON };
  }
  if (answer.allow === true) return undefined;
  const reason = typeof answer.reason === "string" && answer.reason.trim() ? answer.reason : UNCHECKED_REASON;
  return { block: true, blockReason: reason };
}

/** Where the gateway's preload keeps the shim's plugin loopback token
 *  (src/openclaw/gateway-auth.ts PLUGIN_TOKEN_SLOT): process memory only,
 *  never an environment variable, so exec commands cannot present it. */
export const PLUGIN_TOKEN_SLOT = Symbol.for("knox.pluginLoopbackToken");

/** Loopback base URL + auth, read at call time (see the other knox plugins). */
export function loopback() {
  const port = process.env.AGENT_HTTP_PORT || "8080";
  const slot = process[PLUGIN_TOKEN_SLOT];
  return { base: `http://127.0.0.1:${port}`, token: typeof slot === "string" ? slot : "" };
}

/** POST JSON to a shim loopback route; the parsed answer, or null on any failure. */
export async function postShim(path, body, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const { base, token } = loopback();
  if (!token) return null;
  try {
    const res = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

/** GET a shim loopback route; the parsed answer, or null on any failure. */
export async function getShim(path, { fetchImpl = fetch, timeoutMs = 3_000 } = {}) {
  const { base, token } = loopback();
  if (!token) return null;
  try {
    const res = await fetchImpl(`${base}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}
