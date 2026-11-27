import type { IncomingMessage, ServerResponse } from "node:http";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { voiceConversations } from "../voice/call-mirror.js";
import { PhoneStepUp, SupabasePinStore } from "../voice/step-up.js";
import { HttpError } from "./auth.js";
import { requireGatewayToken } from "./routes-files.js";
import { bootMemoryDigest, isUntrustedChannel, parseSessionKey } from "./session-policy.js";
import {
  directServerNames,
  SessionPolicyService,
  SupabaseSessionTrustStore,
  workspaceDirOf,
} from "./session-policy-service.js";
import { readJsonBody, sendJson } from "./util.js";

/**
 * Loopback routes of the knox-session-policy openclaw plugin:
 *
 *   POST /internal/tool-policy     { session_key, tool_name, params }
 *        -> { allow: true } | { allow: false, reason }
 *        The session rules (session-policy.ts).
 *   POST /internal/voice-step-up   { session_key, pin } -> { ok, text }
 *        The phone caller's PIN (../voice/step-up.ts).
 *   GET  /internal/session-context?session_key=
 *        -> { channel, memory_digest? }   the boot memory digest, for trusted
 *        sessions only.
 *
 * Gateway-token authed like the other /internal routes.
 */

export interface PolicyRuntime {
  policy: SessionPolicyService;
  phone: PhoneStepUp;
}

/** The policy mode the env asks for (default enforce). */
export function policyMode(env: Pick<AgentEnv, "AGENT_SESSION_TOOL_POLICY">): "enforce" | "audit" | "off" {
  return env.AGENT_SESSION_TOOL_POLICY ?? "enforce";
}

export function createPolicyRuntime(env: AgentEnv): PolicyRuntime {
  const phone = new PhoneStepUp({ store: new SupabasePinStore(env), calls: voiceConversations });
  const servers = directServerNames(env.OPENCLAW_MCP_SERVERS);
  const policy = new SessionPolicyService({
    agentUid: env.AGENT_UID,
    agentOrg: env.AGENT_ORG,
    store: new SupabaseSessionTrustStore(env),
    phone,
    servers,
    workspaceDir: workspaceDirOf(env),
    envOptIns: env.AGENT_UNTRUSTED_SESSION_TOOLS ?? null,
    mode: policyMode(env),
  });
  return { policy, phone };
}

/** The console session a stamped session key names (for the console MCP route). */
export function sessionIdsFor(
  runtime: Pick<PolicyRuntime, "phone">,
  sessionKey: string,
): { conversationId: string | null; taskId: string | null } {
  const { kind, id } = parseSessionKey(sessionKey);
  if (kind === "webchat" || kind === "a2a") return { conversationId: id, taskId: null };
  if (kind === "task") return { conversationId: null, taskId: id };
  if (kind === "voice") return { conversationId: runtime.phone.conversationFor(sessionKey), taskId: null };
  return { conversationId: null, taskId: null };
}

interface ToolPolicyBody {
  session_key?: unknown;
  tool_name?: unknown;
  params?: unknown;
}

export async function handleToolPolicy(
  req: IncomingMessage,
  res: ServerResponse,
  env: AgentEnv,
  runtime: PolicyRuntime,
): Promise<void> {
  requireGatewayToken(req.headers.authorization, env);
  const body = (await readJsonBody<ToolPolicyBody>(req)) ?? {};
  const sessionKey = typeof body.session_key === "string" ? body.session_key : null;
  const toolName = typeof body.tool_name === "string" ? body.tool_name.trim() : "";
  if (!toolName) return sendJson(res, 200, { allow: false, reason: "A tool call with no tool name can't run." });
  const { decision } = await runtime.policy.decide(sessionKey, toolName, body.params);
  return sendJson(res, 200, decision);
}

export async function handleVoiceStepUp(
  req: IncomingMessage,
  res: ServerResponse,
  env: AgentEnv,
  runtime: PolicyRuntime,
): Promise<void> {
  requireGatewayToken(req.headers.authorization, env);
  const body = (await readJsonBody<{ session_key?: unknown; pin?: unknown }>(req)) ?? {};
  const sessionKey = typeof body.session_key === "string" ? body.session_key : "";
  if (parseSessionKey(sessionKey).kind !== "voice") {
    return sendJson(res, 200, { ok: false, text: "This only works on a phone call." });
  }
  const result = await runtime.phone.verify(sessionKey, body.pin);
  return sendJson(res, 200, result);
}

export async function handleSessionContext(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  env: AgentEnv,
  runtime: PolicyRuntime,
): Promise<void> {
  requireGatewayToken(req.headers.authorization, env);
  const sessionKey = url.searchParams.get("session_key");
  const session = await runtime.policy.session(sessionKey);
  // Audit and off modes change nothing a session sees.
  const trusted = !isUntrustedChannel(session.channel) || runtime.policy.mode !== "enforce";
  return sendJson(res, 200, {
    channel: session.channel,
    ...(trusted && bootMemoryDigest.current ? { memory_digest: bootMemoryDigest.current } : {}),
  });
}

/** Route one of the policy loopback paths; false when the path isn't one of them. */
export async function routePolicy(
  path: string,
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  env: AgentEnv,
  runtime: PolicyRuntime,
): Promise<boolean> {
  if (path === "/internal/tool-policy") {
    if (method !== "POST") throw new HttpError(405, "method not allowed");
    await handleToolPolicy(req, res, env, runtime);
    return true;
  }
  if (path === "/internal/voice-step-up") {
    if (method !== "POST") throw new HttpError(405, "method not allowed");
    await handleVoiceStepUp(req, res, env, runtime);
    return true;
  }
  if (path === "/internal/session-context") {
    if (method !== "GET") throw new HttpError(405, "method not allowed");
    await handleSessionContext(url, req, res, env, runtime);
    return true;
  }
  return false;
}

/** Log the policy wiring once at startup (no secrets). */
export function logPolicyRuntime(env: AgentEnv): void {
  log.info("session tool policy", {
    mode: policyMode(env),
    direct_servers: directServerNames(env.OPENCLAW_MCP_SERVERS).length,
    console_mcp_session_headers: env.AGENT_PLATFORM_MCP_FORWARD,
  });
}
