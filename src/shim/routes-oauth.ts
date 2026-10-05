import type { IncomingMessage, ServerResponse } from "node:http";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import type { GatewayProcess } from "../openclaw/gateway-process.js";
import { persistOAuthStore } from "../provision/oauth-store.js";
import { switchConfigFileToOAuth } from "../provision/render-workspace.js";
import { openWhenGatewayReady, serializeConfigWrite, type RefreshGate } from "../skills/refresh.js";
import { HttpError, type Principal } from "./auth.js";
import type { OAuthSessionManager } from "./oauth-session.js";
import type { MessagingDB } from "./supabase-db.js";
import { readJsonBody, sendJson } from "./util.js";

/**
 * Model-provider OAuth control surface. The console drives the
 * remote/headless OpenAI-Codex (ChatGPT) OAuth flow against the running
 * container:
 *
 *   POST /api/v1/auth/oauth/start    { provider } -> { url }
 *   POST /api/v1/auth/oauth/complete { provider, callbackUrl } -> { ok }
 *   GET  /api/v1/auth/oauth/status   -> { mode, provider, connected }
 *
 * Only org members (user sessions) may run these; agent-to-agent tokens are
 * rejected — minting a subscription credential is an operator action.
 */

const SUPPORTED_PROVIDERS = new Set(["openai-codex"]);

export interface OAuthDeps {
  env: AgentEnv;
  db: MessagingDB;
  sessions: OAuthSessionManager;
  gateway: Pick<GatewayProcess, "restart" | "waitUntilReady">;
  /** The process-wide skills refresh gate (../skills/refresh.ts), held closed
   *  while the gateway restarts. Absent in standalone callers. */
  refreshGate?: RefreshGate;
  /** Override for the post-restart watcher settle (tests). */
  refreshGateSettleMs?: number;
}

async function requireOrgUser(
  principal: Principal,
  env: AgentEnv,
  db: MessagingDB,
): Promise<void> {
  if (principal.kind !== "user") {
    throw new HttpError(403, "an operator (user) session is required");
  }
  const member = await db.userInOrg(principal.userId, env.AGENT_ORG);
  if (!member) throw new HttpError(403, "forbidden");
}

function resolveProvider(body: { provider?: unknown }): string {
  const provider =
    typeof body.provider === "string" && body.provider.trim()
      ? body.provider.trim()
      : "openai-codex";
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new HttpError(400, `unsupported OAuth provider: ${provider}`);
  }
  return provider;
}

export function handleOAuthStatus(env: AgentEnv, res: ServerResponse): void {
  const oauth = env.LLM_AUTH_MODE === "oauth";
  sendJson(res, 200, {
    ok: true,
    mode: env.LLM_AUTH_MODE,
    provider: oauth ? "openai-codex" : null,
    // The container is "configured for" OAuth via env; whether a token has
    // actually been minted is reflected by the agent being able to answer.
    connected: oauth,
  });
}

export async function handleOAuthStart(
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  deps: OAuthDeps,
): Promise<void> {
  const { env, db, sessions } = deps;
  await requireOrgUser(principal, env, db);
  const body = (await readJsonBody<{ provider?: unknown }>(req)) ?? {};
  const provider = resolveProvider(body);

  const url = await sessions.start(provider);
  log.info("oauth flow started", { provider, agent: env.AGENT_UID });
  sendJson(res, 200, { ok: true, url });
}

export async function handleOAuthComplete(
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  deps: OAuthDeps,
): Promise<void> {
  const { env, db, sessions, gateway, refreshGate } = deps;
  await requireOrgUser(principal, env, db);
  const body =
    (await readJsonBody<{ provider?: unknown; callbackUrl?: unknown }>(req)) ??
    {};
  const provider = resolveProvider(body);
  const callbackUrl =
    typeof body.callbackUrl === "string" ? body.callbackUrl.trim() : "";
  if (!callbackUrl) throw new HttpError(400, "callbackUrl is required");

  await sessions.complete(provider, callbackUrl);

  // Hold skills refreshes until the restarted gateway is watching
  // openclaw.json again: a rev bump written while the new child starts would
  // be missed (it attaches its watcher only after it reports ready), so
  // SkillSync and the deprecated routes queue meanwhile. Reopened — flushing
  // the queue as one forced skills.* change — whatever happens below.
  const epoch = refreshGate?.close();
  try {
    // Flip the on-disk openclaw.json from API-key to OAuth so the gateway
    // restart below actually uses the new profile (boot rendered it in
    // API-key mode; future cold boots reproduce OAuth from LLM_AUTH_MODE).
    // Serialized with skills rev bumps so neither write loses the other.
    await serializeConfigWrite(() => switchConfigFileToOAuth(env.OPENCLAW_STATE_DIR));

    // Back up the freshly-minted (encrypted) store so it survives redeploys.
    // Non-fatal: the token is already live in-container; a failed backup just
    // means a future redeploy would need re-auth, which we surface in logs.
    await persistOAuthStore(env).catch((err) => {
      log.warn("oauth store persist failed (token is live but not backed up)", {
        err: String(err),
      });
    });

    // Restart the gateway so it re-reads openclaw.json + the new auth profile.
    // No Railway redeploy — just the openclaw child.
    await gateway.restart();
  } finally {
    if (refreshGate) {
      void openWhenGatewayReady(refreshGate, gateway, {
        epoch,
        ...(deps.refreshGateSettleMs !== undefined ? { settleMs: deps.refreshGateSettleMs } : {}),
      });
    }
  }

  log.info("oauth flow completed", { provider, agent: env.AGENT_UID });
  sendJson(res, 200, { ok: true });
}
