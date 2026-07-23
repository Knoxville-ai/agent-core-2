import type { IncomingMessage, ServerResponse } from "node:http";

import type { AgentEnv } from "../env.js";
import type { DelegatedCredentialStore } from "./delegated-credentials.js";
import { requireGatewayToken } from "./routes-files.js";
import { sendJson } from "./util.js";

/**
 * Loopback credential lookup for the openclaw `before_tool_call` plugin.
 *
 *   GET /internal/delegated-credentials?session_key=<key>
 *     -> { credentials: { ENV_KEY: value, ... } }   (empty object when none)
 *
 * This is the ONE place the shim hands the raw delegated secret values out, and
 * it does so only to the in-container skill-execution layer (the gateway plugin
 * over loopback) — never to the model. Authed with the gateway token, the same
 * trust anchor as `/files` and `/skills`; the token only ever lives on the
 * console server and inside this container, so it gates access to the values.
 *
 * NEVER logs the values (this handler logs nothing at all). Returns `{}` for an
 * unknown/expired session key so the plugin simply injects no env.
 */
export function handleDelegatedCredentialsLookup(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  env: AgentEnv,
  store: DelegatedCredentialStore,
): void {
  requireGatewayToken(req.headers.authorization, env);
  const sessionKey = url.searchParams.get("session_key") ?? "";
  const credentials = sessionKey ? store.get(sessionKey) : {};
  sendJson(res, 200, { credentials });
}
