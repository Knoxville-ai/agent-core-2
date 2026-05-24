import type { ServerResponse } from "node:http";

import type { AgentEnv } from "../env.js";
import { sendJson } from "./util.js";

export function handleHealth(res: ServerResponse): void {
  sendJson(res, 200, { ok: true, service: "agent-core", role: "vessel" });
}

/**
 * Readiness check: probes the local openclaw HTTP surface to confirm
 * the gateway is up and the chat-completions endpoint is reachable.
 * 503 until openclaw finishes starting (Railway's healthcheck will keep
 * the container in "starting" until then).
 */
export async function handleReady(
  res: ServerResponse,
  env: AgentEnv,
): Promise<void> {
  const url = `http://127.0.0.1:${env.OPENCLAW_GATEWAY_PORT}/v1/models`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const probe = await fetch(url, {
      headers: { Authorization: `Bearer ${env.OPENCLAW_GATEWAY_TOKEN}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (probe.ok) {
      sendJson(res, 200, { ok: true, gateway: "ready" });
      return;
    }
    sendJson(res, 503, { ok: false, gateway: `status=${probe.status}` });
  } catch (err) {
    sendJson(res, 503, {
      ok: false,
      gateway: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
