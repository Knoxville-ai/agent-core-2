import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import type { GatewayClient } from "../openclaw/gateway-client.js";
import { HttpError, verifyConsoleBearer } from "./auth.js";
import { handleFilesPlaceholder } from "./routes-files.js";
import { handleHealth, handleReady } from "./routes-health.js";
import { handleInterrupt } from "./routes-interrupt.js";
import { handleSendMessage } from "./routes-messages.js";
import { SessionRegistry } from "./sessions.js";
import { sendJson } from "./util.js";

interface ServerHandle {
  close: () => Promise<void>;
}

export function startShim(
  env: AgentEnv,
  gateway: GatewayClient,
): Promise<ServerHandle> {
  const sessions = new SessionRegistry(gateway);

  const server = createServer((req, res) => {
    void route(req, res, env, gateway, sessions).catch((err) => {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { ok: false, error: err.message });
      } else {
        log.error("unhandled shim error", { err: String(err) });
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: "internal error" });
        } else {
          res.end();
        }
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(env.AGENT_HTTP_PORT, "0.0.0.0", () => {
      log.info("shim listening", { port: env.AGENT_HTTP_PORT });
      resolve({
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  env: AgentEnv,
  gateway: GatewayClient,
  sessions: SessionRegistry,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();

  // Public endpoints (no auth).
  if (path === "/healthz" || path === "/health") return handleHealth(res);
  if (path === "/readyz") return handleReady(res, gateway);

  // Everything below requires a valid console bearer.
  await verifyConsoleBearer(req.headers.authorization, env);

  // POST /api/v1/conversations/:id/messages
  const convMatch = /^\/api\/v1\/conversations\/([^/]+)\/(messages|interrupt)$/.exec(
    path,
  );
  if (convMatch) {
    const conversationId = convMatch[1]!;
    const sub = convMatch[2]!;
    if (method !== "POST") {
      throw new HttpError(405, "method not allowed");
    }
    if (sub === "messages") {
      return handleSendMessage(conversationId, req, res, gateway, sessions);
    }
    if (sub === "interrupt") {
      return handleInterrupt(conversationId, req, res, gateway, sessions);
    }
  }

  // /api/v1/agents/:uid/files/...  (legacy file surface — placeholder)
  if (/^\/api\/v1\/agents\/[^/]+\/files(\/|$)/.test(path)) {
    return handleFilesPlaceholder(req, res);
  }

  throw new HttpError(404, `no route for ${method} ${path}`);
}
