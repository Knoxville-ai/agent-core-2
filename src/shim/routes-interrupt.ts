import type { IncomingMessage, ServerResponse } from "node:http";

import type { GatewayClient } from "../openclaw/gateway-client.js";
import type { SessionRegistry } from "./sessions.js";
import { sendJson } from "./util.js";

/**
 * POST /api/v1/conversations/:id/interrupt — maps to chat.abort on the
 * underlying openclaw session.
 */
export async function handleInterrupt(
  conversationId: string,
  _req: IncomingMessage,
  res: ServerResponse,
  gateway: GatewayClient,
  sessions: SessionRegistry,
): Promise<void> {
  const sessionKey = await sessions.resolve(conversationId);
  try {
    await gateway.request("chat.abort", { key: sessionKey });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 502, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
