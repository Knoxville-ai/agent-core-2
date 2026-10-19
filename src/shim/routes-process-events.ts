import type { IncomingMessage, ServerResponse } from "node:http";

import type { AgentEnv } from "../env.js";
import { newCallId, splitToolName, type ProcessEvents } from "./process-events.js";
import { requireGatewayToken } from "./routes-files.js";
import { readJsonBody, sendJson } from "./util.js";

/**
 * Loopback routes for the knox-process-events openclaw plugin (see
 * process-events.ts). Gateway-token authed like the other /internal routes.
 *
 *   POST /internal/process-events/guard   {tool_name, params}
 *        → {allowed, reason}: may this call run. Built-in and undeclared tools
 *          always may; answered without a network call.
 *   POST /internal/process-events/record  {tool_name, params, result, error, tool_call_id, run_id}
 *        → 202 at once; a declared call is reported in the background.
 *
 * With process events off (no reporter), every call is allowed and nothing is
 * recorded.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export async function handleProcessEventsGuard(
  req: IncomingMessage,
  res: ServerResponse,
  env: AgentEnv,
  events: ProcessEvents | null,
): Promise<void> {
  requireGatewayToken(req.headers.authorization, env);
  const body = await readJsonBody<Record<string, unknown>>(req).catch(() => null);
  const name = typeof body?.tool_name === "string" ? splitToolName(body.tool_name) : null;
  if (!events || !name) {
    sendJson(res, 200, { allowed: true, reason: null });
    return;
  }
  sendJson(res, 200, await events.guard(name, isRecord(body?.params) ? body.params : {}));
}

export async function handleProcessEventsRecord(
  req: IncomingMessage,
  res: ServerResponse,
  env: AgentEnv,
  events: ProcessEvents | null,
): Promise<void> {
  requireGatewayToken(req.headers.authorization, env);
  const body = await readJsonBody<Record<string, unknown>>(req).catch(() => null);
  sendJson(res, 202, { ok: true });
  const name = typeof body?.tool_name === "string" ? splitToolName(body.tool_name) : null;
  if (!events || !name || !body) return;
  const id = typeof body.tool_call_id === "string" && body.tool_call_id ? body.tool_call_id : null;
  const run = typeof body.run_id === "string" && body.run_id ? body.run_id : "";
  const result = body.result;
  void events.record({
    ...name,
    args: isRecord(body.params) ? body.params : {},
    result,
    isError: (typeof body.error === "string" && body.error.trim() !== "") || (isRecord(result) && result.isError === true),
    callId: id ? `openclaw:${run}:${id}`.slice(0, 128) : newCallId(),
    finishedAt: new Date().toISOString(),
  });
}
