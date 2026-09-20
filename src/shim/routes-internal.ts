import type { IncomingMessage, ServerResponse } from "node:http";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { credentialKeyNames, type DelegatedCredentialStore } from "./delegated-credentials.js";
import { requireGatewayToken } from "./routes-files.js";
import { parseUsageSample, type UsageAccumulator } from "./usage-telemetry.js";
import type { ToolCallHub } from "./tool-telemetry.js";
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
  // openclaw's session id off the llm_output event — the key the cost proxy
  // summed this turn's per-call cost under (it reads the same id as the request's
  // `prompt_cache_key`). Optional: absent from an older plugin, in which case the
  // turn keeps its token breakdown and just gets no actual cost.
  const sessionId = typeof body?.session_id === "string" ? body.session_id : undefined;
  const sample = parseUsageSample(body);
  if (!sessionKey || !sample) {
    log.debug("llm usage ingest ignored", {
      session_key: sessionKey || null,
      parsed: Boolean(sample),
    });
    sendJson(res, 200, { ok: true, recorded: false });
    return;
  }
  usage.add(sessionKey, sample, sessionId);
  sendJson(res, 200, { ok: true, recorded: true });
}

/**
 * Loopback tool-call ingest for the openclaw `knox-tool-telemetry` plugin.
 *
 *   POST /internal/tool-call
 *     { phase: "start", session_key, tool_name, server?, tool_call_id?, args_preview? }
 *     { phase: "end",   session_key, tool_name?, tool_call_id?, status, duration_ms? }
 *     -> { ok: true }
 *
 * OpenClaw runs the tool loop internally and the OpenAI-compat stream the shim
 * reads carries no tool calls, so this side channel is the ONLY way the shim
 * learns a tool ran. The `start` phase inserts a row into `agent_tool_calls`
 * (attributed to the live turn's conversation/task/assistant message); the `end`
 * phase enriches it with the outcome. See tool-telemetry.ts.
 *
 * Same loopback + gateway-token trust anchor as `/internal/llm-usage`.
 * `args_preview` was already redacted + size-bounded by the plugin, inside the
 * gateway, before it crossed this route — no secret and no raw prompt text is
 * ever meant to arrive here.
 *
 * Always 200s. Telemetry must never be able to fail a tool call, so a bad body
 * is counted and dropped rather than surfaced as an error the plugin would retry.
 */
export async function handleToolCallIngest(
  req: IncomingMessage,
  res: ServerResponse,
  env: AgentEnv,
  hub: ToolCallHub,
): Promise<void> {
  requireGatewayToken(req.headers.authorization, env);
  if (!hub.enabled) {
    sendJson(res, 200, { ok: true, recorded: false });
    return;
  }
  const body = await readJsonBody<Record<string, unknown>>(req).catch(() => null);
  const phase = typeof body?.phase === "string" ? body.phase : "";
  const sessionKey = typeof body?.session_key === "string" ? body.session_key : null;
  const toolName = typeof body?.tool_name === "string" ? body.tool_name : null;
  const toolCallId =
    typeof body?.tool_call_id === "string" ? body.tool_call_id : null;

  try {
    if (phase === "start") {
      if (!toolName) {
        sendJson(res, 200, { ok: true, recorded: false });
        return;
      }
      await hub.recordStart({
        sessionKey,
        toolName,
        server: typeof body?.server === "string" ? body.server : null,
        toolCallId,
        argsPreview: body?.args_preview ?? null,
      });
    } else if (phase === "end") {
      const status = body?.status === "error" ? "error" : "ok";
      const durationRaw = body?.duration_ms;
      await hub.recordEnd({
        sessionKey,
        toolName,
        toolCallId,
        status,
        error: typeof body?.error === "string" ? body.error : null,
        durationMs:
          typeof durationRaw === "number" && Number.isFinite(durationRaw)
            ? durationRaw
            : null,
      });
    } else {
      sendJson(res, 200, { ok: true, recorded: false });
      return;
    }
  } catch (err) {
    // Fail open — a telemetry error must never propagate to the tool call.
    log.warn("tool-call ingest threw (non-fatal)", { err: String(err) });
  }
  sendJson(res, 200, { ok: true, recorded: true });
}
