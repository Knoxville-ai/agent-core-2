import type { IncomingMessage, ServerResponse } from "node:http";

import { log } from "../log.js";
import type { GatewayClient, SessionEvent } from "../openclaw/gateway-client.js";
import type { SessionRegistry } from "./sessions.js";
import { HttpError } from "./auth.js";
import { readJsonBody } from "./util.js";

/**
 * POST /api/v1/conversations/:id/messages
 *
 * Console contract (knoxville-ai-console/src/app/api/org/[orgId]/messages/
 * [conversationId]/stream/route.ts): the console POSTs the user's message
 * to this endpoint and expects an SSE response stream the browser can
 * consume directly.
 *
 * SSE event types we emit:
 *   event: delta       data: { text: "..." }
 *   event: tool_call   data: { name, args }
 *   event: tool_result data: { name, ok, summary }
 *   event: done        data: { reason }
 *   event: error       data: { message }
 *
 * The shape mirrors what the existing console UI already renders.
 */
export async function handleSendMessage(
  conversationId: string,
  req: IncomingMessage,
  res: ServerResponse,
  gateway: GatewayClient,
  sessions: SessionRegistry,
): Promise<void> {
  const body = await readJsonBody<{ text?: string }>(req);
  const text = (body?.text ?? "").toString();
  if (!text.trim()) {
    throw new HttpError(400, "body.text required");
  }

  const sessionKey = await sessions.resolve(conversationId);

  // Open SSE before we send the turn — the console expects byte-1 quickly.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const writeEvent = (event: string, data: unknown): void => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Subscribe BEFORE sending so we don't miss the first deltas.
  const eventHandler = (ev: SessionEvent): void => {
    const eventSession =
      (ev.payload.session as string | undefined) ??
      (ev.payload.sessionKey as string | undefined) ??
      (ev.payload.key as string | undefined);
    if (eventSession && eventSession !== sessionKey) return;

    switch (ev.event) {
      case "session.message":
      case "chat.delta": {
        const delta = ev.payload.deltaText as string | undefined;
        if (delta) writeEvent("delta", { text: delta });
        break;
      }
      case "session.tool":
      case "chat.tool": {
        writeEvent("tool_call", {
          name: ev.payload.name ?? null,
          args: ev.payload.args ?? null,
        });
        break;
      }
      case "session.operation": {
        writeEvent("tool_result", {
          name: ev.payload.name ?? null,
          ok: ev.payload.ok ?? null,
          summary: ev.payload.summary ?? null,
        });
        break;
      }
      case "chat.done":
      case "session.done": {
        writeEvent("done", { reason: ev.payload.reason ?? "completed" });
        cleanup();
        res.end();
        break;
      }
      case "chat.error":
      case "session.error": {
        writeEvent("error", {
          message: ev.payload.message ?? "unknown gateway error",
        });
        cleanup();
        res.end();
        break;
      }
    }
  };

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    gateway.off("event", eventHandler);
  };

  req.on("close", () => {
    cleanup();
    // Caller hung up mid-stream — best-effort abort the in-flight turn so
    // the agent doesn't keep burning tokens. Ignore failure.
    gateway.request("chat.abort", { key: sessionKey }).catch(() => undefined);
  });

  gateway.on("event", eventHandler);

  try {
    // Subscribe explicitly to make sure events route to us.
    await gateway.request("sessions.messages.subscribe", { key: sessionKey });
    await gateway.request("sessions.send", { key: sessionKey, text });
  } catch (err) {
    log.error("sessions.send failed", { err: String(err) });
    writeEvent("error", {
      message: err instanceof Error ? err.message : String(err),
    });
    cleanup();
    res.end();
  }
}
