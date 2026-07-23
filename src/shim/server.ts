import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import type { GatewayProcess } from "../openclaw/gateway-process.js";
import type { MemoryCheckpoint } from "../provision/agent-memory.js";
import { HttpError, verifyBearer } from "./auth.js";
import { CancelRegistry } from "./cancel-registry.js";
import { OAuthSessionManager } from "./oauth-session.js";
import {
  handleFilesList,
  handleFilesPlaceholder,
  handleFilesRead,
  requireGatewayToken,
} from "./routes-files.js";
import { handleHealth, handleReady } from "./routes-health.js";
import { handleInterrupt } from "./routes-interrupt.js";
import { handleSendMessage } from "./routes-messages.js";
import { DelegatedCredentialStore } from "./delegated-credentials.js";
import { handleDelegatedCredentialsLookup } from "./routes-internal.js";
import {
  handleSkillsInstall,
  handleSkillsList,
  handleSkillsRemove,
} from "./routes-skills.js";
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
  memory: MemoryCheckpoint,
): Promise<ServerHandle> {
  const db = new MessagingDB(env);
  const cancels = new CancelRegistry();
  // Per-turn delegated-credential store, shared between the message route
  // (writer) and the loopback lookup route (reader for the gateway plugin).
  const delegatedCreds = new DelegatedCredentialStore();
  const oauth: OAuthDeps = {
    env,
    db,
    sessions: new OAuthSessionManager(env),
    gateway,
  };

  const server = createServer((req, res) => {
    void route(req, res, env, db, cancels, oauth, memory, delegatedCreds).catch((err) => {
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
  memory: MemoryCheckpoint,
  delegatedCreds: DelegatedCredentialStore,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();

  // Public endpoints (no auth).
  if (path === "/healthz" || path === "/health") return handleHealth(res);
  if (path === "/readyz") return handleReady(res, env);

  // Operator filesystem inspection (the console's Files tab). Authed with
  // the gateway token rather than a user JWT — the console *server* is the
  // only caller and the token never reaches a browser. Handled BEFORE the
  // JWT gate below so the conversation/oauth routes stay JWT-only.
  if (path === "/files/list" || path === "/files/read") {
    if (method !== "GET") throw new HttpError(405, "method not allowed");
    requireGatewayToken(req.headers.authorization, env);
    return path === "/files/list"
      ? handleFilesList(url, res, env)
      : handleFilesRead(url, res, env);
  }

  // Loopback credential lookup for the gateway's before_tool_call plugin.
  // Gateway-token authed like /files; returns the delegated creds staged for a
  // session's current turn so the plugin can inject them into the skill env.
  // The only caller is the in-container gateway plugin over loopback.
  if (path === "/internal/delegated-credentials") {
    if (method !== "GET") throw new HttpError(405, "method not allowed");
    return handleDelegatedCredentialsLookup(url, req, res, env, delegatedCreds);
  }

  // Live skill management (console operator surface). Gateway-token authed like
  // /files/*, handled before the JWT gate. Lets the console install/remove
  // skills into the running agent without a redeploy; each mutation restarts
  // the openclaw gateway in place to reload the skill registry.
  if (path === "/skills" || path.startsWith("/skills/")) {
    requireGatewayToken(req.headers.authorization, env);
    if (path === "/skills") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      return handleSkillsList(res, env);
    }
    if (path === "/skills/install") {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      return handleSkillsInstall(req, res, env, oauth.gateway);
    }
    if (path === "/skills/search") {
      // Registry search isn't wired; the console treats 501 as "unavailable".
      throw new HttpError(501, "skill search not supported");
    }
    const removeMatch = /^\/skills\/(.+)$/.exec(path);
    if (removeMatch && method === "DELETE") {
      return handleSkillsRemove(
        decodeURIComponent(removeMatch[1]!),
        res,
        env,
        oauth.gateway,
      );
    }
    throw new HttpError(405, "method not allowed");
  }

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
        memory,
        delegatedCreds,
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

  // /api/v1/agents/:uid/files/...  (legacy attachment surface — placeholder)
  if (/^\/api\/v1\/agents\/[^/]+\/files(\/|$)/.test(path)) {
    return handleFilesPlaceholder(req, res);
  }

  throw new HttpError(404, `no route for ${method} ${path}`);
}
