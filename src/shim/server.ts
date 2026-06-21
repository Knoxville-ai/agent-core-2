import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import type { GatewayProcess } from "../openclaw/gateway-process.js";
import { HttpError, verifyBearer } from "./auth.js";
import { CancelRegistry } from "./cancel-registry.js";
import { OAuthSessionManager } from "./oauth-session.js";
import { handleFilesPlaceholder } from "./routes-files.js";
import { handleHealth, handleReady } from "./routes-health.js";
import { handleInterrupt } from "./routes-interrupt.js";
import { handleSendMessage } from "./routes-messages.js";
import {
  handleOAuthComplete,
  handleOAuthStart,
  handleOAuthStatus,
  type OAuthDeps,
} from "./routes-oauth.js";
import { MessagingDB } from "./supabase-db.js";
import { sendJson } from "./util.js";

interface ServerHandle {
  close: () => Promise<void>;
}

export function startShim(
  env: AgentEnv,
  gateway: GatewayProcess,
): Promise<ServerHandle> {
  const db = new MessagingDB(env);
  const cancels = new CancelRegistry();
  const oauth: OAuthDeps = {
    env,
    db,
    sessions: new OAuthSessionManager(env),
    gateway,
  };

  const server = createServer((req, res) => {
    void route(req, res, env, db, cancels, oauth).catch((err) => {
      if (err instanceof HttpError) {
        // Don't try to send JSON after an SSE stream has started.
        if (!res.headersSent) {
          sendJson(res, err.status, { ok: false, error: err.message });
        } else {
          try {
            res.end();
          } catch {
            /* ignore */
          }
        }
      } else {
        log.error("unhandled shim error", { err: String(err) });
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: "internal error" });
        } else {
          try {
            res.end();
          } catch {
            /* ignore */
          }
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
  db: MessagingDB,
  cancels: CancelRegistry,
  oauth: OAuthDeps,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();

  // Public endpoints (no auth).
  if (path === "/healthz" || path === "/health") return handleHealth(res);
  if (path === "/readyz") return handleReady(res, env);

  // Everything below requires a valid bearer JWT.
  const principal = await verifyBearer(req.headers.authorization, env);

  // Model-provider OAuth control surface (operator-only; see routes-oauth).
  if (path === "/api/v1/auth/oauth/status") {
    if (method !== "GET") throw new HttpError(405, "method not allowed");
    return handleOAuthStatus(env, res);
  }
  if (path === "/api/v1/auth/oauth/start") {
    if (method !== "POST") throw new HttpError(405, "method not allowed");
    return handleOAuthStart(principal, req, res, oauth);
  }
  if (path === "/api/v1/auth/oauth/complete") {
    if (method !== "POST") throw new HttpError(405, "method not allowed");
    return handleOAuthComplete(principal, req, res, oauth);
  }

  // POST /api/v1/conversations/:id/{messages,interrupt}
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
      return handleSendMessage(conversationId, principal, req, res, {
        env,
        db,
        cancels,
      });
    }
    if (sub === "interrupt") {
      return handleInterrupt(conversationId, principal, req, res, {
        env,
        db,
        cancels,
      });
    }
  }

  // /api/v1/agents/:uid/files/...  (legacy file surface — placeholder)
  if (/^\/api\/v1\/agents\/[^/]+\/files(\/|$)/.test(path)) {
    return handleFilesPlaceholder(req, res);
  }

  throw new HttpError(404, `no route for ${method} ${path}`);
}
