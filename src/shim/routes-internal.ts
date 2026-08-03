import type { IncomingMessage, ServerResponse } from "node:http";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { credentialKeyNames, type DelegatedCredentialStore } from "./delegated-credentials.js";
import { requireGatewayToken } from "./routes-files.js";
import { parseUsageSample, type UsageAccumulator } from "./usage-telemetry.js";
import { readJsonBody, sendJson } from "./util.js";

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
 * Two caller shapes:
 *   - `?session_key=<key>`  -> creds staged for exactly that session (the
 *     openclaw before_tool_call plugin, which knows `ctx.sessionKey`).
 *   - no `session_key`      -> creds of the single currently-live delegated turn
 *     (the exec-shim `docker/knox-python3-shim.py`, which runs inside a skill's
 *     `exec` subprocess where openclaw exposes no session key; see
 *     `DelegatedCredentialStore.currentSingle`).
 *
 * NEVER logs the values — but it DOES log a redacted hit/miss line (session key,
 * whether the store held an entry, the credential NAMES, and the live store size)
 * so the handoff is traceable end-to-end. Returns `{}` for an unknown/expired
 * session (or ambiguous concurrent turns) so the caller simply injects no env.
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
  const credentials = sessionKey ? store.get(sessionKey) : store.currentSingle();
  // Redacted trace: proves the plugin reached the route and whether the store
  // had this session's creds staged. Names + counts only — never the values.
  log.info("delegated credentials lookup", {
    mode: sessionKey ? "by_session" : "current_single",
    session_key: sessionKey || null,
    hit: Object.keys(credentials).length > 0,
    keys: credentialKeyNames(credentials),
    store_size: store.size(),
  });
  sendJson(res, 200, { credentials });
}

/**
 * Loopback token-usage ingest for the openclaw `knox-usage-telemetry` plugin.
 *
 *   POST /internal/llm-usage
 *     { session_key: "<key>", sample: { input, output, cache_read, cache_write, ... } }
 *     -> { ok: true }
 *
 * One POST per MODEL CALL, not per turn — openclaw's `llm_output` hook fires on
 * every iteration of the agentic loop. The shim folds them into a per-turn
 * rollup and writes the totals onto the assistant row's `token_usage` when the
 * turn finalizes.
 *
 * This exists because openclaw's OpenAI-compat endpoint flattens
 * `prompt_tokens = input + cacheRead` and drops the split, so the SSE `usage`
 * frame the shim already reads cannot distinguish a cache hit from a miss.
 *
 * Authed with the gateway token, the same trust anchor as `/files`, `/skills`,
 * and `/internal/delegated-credentials`. Carries token COUNTS only — never
 * prompt text, assistant text, or tool arguments.
 *
 * Always 200s. Telemetry must never be able to fail a turn, so an unparseable
 * body is counted and dropped rather than surfaced as an error the plugin would
 * retry.
 */
export async function handleLlmUsageIngest(
  req: IncomingMessage,
  res: ServerResponse,
  env: AgentEnv,
  usage: UsageAccumulator,
): Promise<void> {
  requireGatewayToken(req.headers.authorization, env);
  const body = await readJsonBody<Record<string, unknown>>(req).catch(() => null);
  const sessionKey = typeof body?.session_key === "string" ? body.session_key : "";
  const sample = parseUsageSample(body);
  if (!sessionKey || !sample) {
    log.debug("llm usage ingest ignored", {
      session_key: sessionKey || null,
      parsed: Boolean(sample),
    });
    sendJson(res, 200, { ok: true, recorded: false });
    return;
  }
  usage.add(sessionKey, sample);
  sendJson(res, 200, { ok: true, recorded: true });
}
