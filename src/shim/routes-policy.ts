import type { IncomingMessage, ServerResponse } from "node:http";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { parseEscalatedTools } from "../prompt/assemble.js";
import { voiceConversations } from "../voice/call-mirror.js";
import { PhoneStepUp, SupabasePinStore, unavailablePinStore } from "../voice/step-up.js";
import { HttpError } from "./auth.js";
import { requirePluginToken } from "./routes-internal.js";
import { bootMemoryDigest, classifyTool, isUntrustedChannel, parseSessionKey } from "./session-policy.js";
import {
  directServerNames,
  scopedSessionTrustStore,
  SessionPolicyService,
  SupabaseSessionTrustStore,
  workspaceDirOf,
} from "./session-policy-service.js";
import { platformMcpForwarded, SessionTickets } from "./platform-mcp-forward.js";
import { MessagingDB } from "./supabase-db.js";
import {
  approvalKey,
  consoleHostedServers,
  PlatformApprovalAsker,
  SupabaseApprovalStore,
  ToolApprovalGate,
} from "./tool-approvals.js";
import { readJsonBody, sendJson } from "./util.js";

/**
 * Loopback routes of the knox-session-policy openclaw plugin:
 *
 *   POST /internal/tool-policy     { session_key, tool_name, params }
 *        -> { allow: true } | { allow: false, reason }
 *        The session rules (session-policy.ts), then the approval gate on
 *        direct connector tools (tool-approvals.ts).
 *   POST /internal/voice-step-up   { session_key, pin } -> { ok, text }
 *        The phone caller's PIN (../voice/step-up.ts).
 *   GET  /internal/session-context?session_key=
 *        -> { channel, memory_digest? }   the boot memory digest, for trusted
 *        sessions only.
 *
 * Authed with the plugin loopback token, like every /internal route.
 */

export interface PolicyRuntime {
  policy: SessionPolicyService;
  approvals: ToolApprovalGate;
  phone: PhoneStepUp;
  /** Single-use session tickets for the console MCP forward route. */
  tickets: SessionTickets;
  /** Whether openclaw reaches the console MCP through the forward route. */
  forwarding: boolean;
}

/** The policy mode the env asks for (default enforce). */
export function policyMode(env: Pick<AgentEnv, "AGENT_SESSION_TOOL_POLICY">): "enforce" | "audit" | "off" {
  return env.AGENT_SESSION_TOOL_POLICY ?? "enforce";
}

/**
 * The policy runtime. With the database key (service-key mode) it reads the
 * console's tables directly. Without one (scoped mode, ../agent-data) only the
 * agent data API's own operations are available, so: the session rules fall
 * back to the conversation and the turn's caller (scopedSessionTrustStore),
 * opt-ins are none, phone PINs can't be checked (callers stay restricted) and
 * direct-server approvals are refused — each until the console offers an
 * operation for it.
 */
export function createPolicyRuntime(env: AgentEnv, db?: MessagingDB): PolicyRuntime {
  const serviceKey = Boolean(env.SUPABASE_SERVICE_ROLE_KEY);
  const phone = new PhoneStepUp({
    store: serviceKey ? new SupabasePinStore(env) : unavailablePinStore,
    calls: voiceConversations,
  });
  const servers = directServerNames(env.OPENCLAW_MCP_SERVERS);
  const policy = new SessionPolicyService({
    agentUid: env.AGENT_UID,
    agentOrg: env.AGENT_ORG,
    store: serviceKey ? new SupabaseSessionTrustStore(env) : scopedSessionTrustStore(db ?? new MessagingDB(env)),
    scoped: !serviceKey,
    phone,
    servers,
    workspaceDir: workspaceDirOf(env),
    envOptIns: env.AGENT_UNTRUSTED_SESSION_TOOLS ?? null,
    mode: policyMode(env),
  });
  const approvals = new ToolApprovalGate({
    agentUid: env.AGENT_UID,
    escalated: parseEscalatedTools(env.OPENCLAW_TOOLS_ESCALATE),
    servers,
    consoleHosted: consoleHostedServers(env.OPENCLAW_MCP_SERVERS, env.PLATFORM_MCP_URL),
    key: approvalKey(env.OPENCLAW_GATEWAY_TOKEN),
    store: serviceKey ? new SupabaseApprovalStore(env) : null,
    asker: env.PLATFORM_MCP_URL && env.PLATFORM_API_TOKEN ? new PlatformApprovalAsker(env) : null,
  });
  return { policy, approvals, phone, tickets: new SessionTickets(), forwarding: platformMcpForwarded(env) };
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
  requirePluginToken(req.headers.authorization);
  const body = (await readJsonBody<ToolPolicyBody>(req)) ?? {};
  const sessionKey = typeof body.session_key === "string" ? body.session_key : null;
  const toolName = typeof body.tool_name === "string" ? body.tool_name.trim() : "";
  if (!toolName) return sendJson(res, 200, { allow: false, reason: "A tool call with no tool name can't run." });
  const { decision, session } = await runtime.policy.decide(sessionKey, toolName, body.params);
  if (!decision.allow) return sendJson(res, 200, decision);
  const approval = await runtime.approvals.check(toolName, body.params, session);
  if (!approval.allow) return sendJson(res, 200, approval);
  // A platform tool call that may run gets a ticket naming its session, for the
  // console MCP forward route (platform-mcp-forward.ts).
  const cls = classifyTool(toolName, []);
  if (runtime.forwarding && sessionKey && cls.kind === "platform") {
    return sendJson(res, 200, { allow: true, session_ticket: runtime.tickets.issue(sessionKey, cls.tool) });
  }
  return sendJson(res, 200, { allow: true });
}

export async function handleVoiceStepUp(
  req: IncomingMessage,
  res: ServerResponse,
  env: AgentEnv,
  runtime: PolicyRuntime,
): Promise<void> {
  requirePluginToken(req.headers.authorization);
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
  requirePluginToken(req.headers.authorization);
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
    approval_gated_tools: parseEscalatedTools(env.OPENCLAW_TOOLS_ESCALATE).length,
    console_mcp_session_headers: env.AGENT_PLATFORM_MCP_FORWARD,
  });
}
