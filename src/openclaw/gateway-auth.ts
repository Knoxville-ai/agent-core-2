import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { AgentEnv } from "../env.js";

/**
 * The two loopback credentials between the shim and the openclaw gateway, and
 * why neither is the console's OPENCLAW_GATEWAY_TOKEN.
 *
 * OPENCLAW_GATEWAY_TOKEN is the console's credential for this container's
 * operator routes (`/files`, `/skills`). It stays in the shim: it is not in the
 * gateway's environment (see ./child-env.ts) and not in openclaw.json.
 *
 * 1. Gateway auth token — shim → gateway. openclaw requires a token in
 *    openclaw.json (`gateway.auth.token`), and that file is readable by every
 *    process of the agent uid, so the shim writes a value DERIVED from
 *    OPENCLAW_GATEWAY_TOKEN (HMAC, one-way): stable across restarts, useless
 *    against the shim's own routes, and revealing nothing about the console's
 *    token.
 *
 * 2. Plugin loopback token — gateway plugins → shim `/internal/*` routes
 *    (delegated credentials, usage and tool telemetry, voice lookups). Random
 *    per shim process, never written to disk and never put in any
 *    environment: the shim hands it to the gateway over an inherited pipe
 *    (fd 3), the gateway's preload reads it into a process-local slot
 *    (`PLUGIN_TOKEN_SLOT`) before openclaw starts, and the gateway is
 *    non-dumpable. So exec commands — which can read openclaw.json and their
 *    own environment — cannot present it.
 */

const GATEWAY_AUTH_CONTEXT = "knox:openclaw-gateway-auth:v1";

/** `gateway.auth.token` in openclaw.json, and the bearer the shim sends the gateway. */
export function gatewayAuthToken(env: Pick<AgentEnv, "OPENCLAW_GATEWAY_TOKEN">): string {
  return createHmac("sha256", env.OPENCLAW_GATEWAY_TOKEN)
    .update(GATEWAY_AUTH_CONTEXT)
    .digest("base64url");
}

/** Env var naming the inherited fd the gateway reads the plugin token from. */
export const PLUGIN_TOKEN_FD_ENV = "KNOX_PLUGIN_TOKEN_FD";
/** The fd: stdio index 3 of the gateway child. */
export const PLUGIN_TOKEN_FD = 3;
/** Where the gateway's preload keeps the token (a symbol-keyed, non-enumerable
 *  property of `process`, shared by every module realm in the process). */
export const PLUGIN_TOKEN_SLOT = "knox.pluginLoopbackToken";

let pluginToken: string | null = null;

/** This shim process's plugin loopback token (generated on first use). */
export function pluginLoopbackToken(): string {
  pluginToken ??= randomBytes(32).toString("base64url");
  return pluginToken;
}

/** True when `authorization` is `Bearer <plugin loopback token>`. */
export function isPluginLoopbackAuth(authorization: string | undefined): boolean {
  if (!authorization || !authorization.startsWith("Bearer ")) return false;
  const presented = authorization.slice("Bearer ".length).trim();
  if (!presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(pluginLoopbackToken()).digest();
  return timingSafeEqual(a, b);
}

const PLATFORM_FORWARD_CONTEXT = "knox:platform-mcp-forward:v1";

/**
 * 3. Console MCP forward token — openclaw's MCP client (and the git credential
 *    helper) → shim `/internal/platform-mcp`. openclaw reads MCP server auth
 *    from openclaw.json, so like the gateway auth token this one is DERIVED
 *    from OPENCLAW_GATEWAY_TOKEN (HMAC, its own context): stable, file-borne,
 *    and accepted by that one route only. It names no session: the session
 *    headers the route adds come only from single-use tickets the shim issues
 *    to the session-policy plugin over the plugin loopback token
 *    (../shim/platform-mcp-forward.ts).
 */
export function platformForwardToken(env: Pick<AgentEnv, "OPENCLAW_GATEWAY_TOKEN">): string {
  return createHmac("sha256", env.OPENCLAW_GATEWAY_TOKEN)
    .update(PLATFORM_FORWARD_CONTEXT)
    .digest("base64url");
}

/** True when `authorization` is `Bearer <console MCP forward token>`. */
export function isPlatformForwardAuth(
  authorization: string | undefined,
  env: Pick<AgentEnv, "OPENCLAW_GATEWAY_TOKEN">,
): boolean {
  if (!authorization || !authorization.startsWith("Bearer ")) return false;
  const presented = authorization.slice("Bearer ".length).trim();
  if (!presented || !env.OPENCLAW_GATEWAY_TOKEN) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(platformForwardToken(env)).digest();
  return timingSafeEqual(a, b);
}
