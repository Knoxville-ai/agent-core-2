import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Which tools a session may use, judged by who is driving it (SEC-021,
 * SEC-023). Pure rules, no I/O: session-policy-service.ts reads the rows and
 * caches the verdicts; the knox-session-policy openclaw plugin asks it before
 * every tool call.
 *
 * The console limits its own MCP tools by the session a call comes from
 * (console src/lib/tool-access/session-trust.ts). The tools that run here in
 * the container — exec and the file tools, connector MCP servers the agent
 * reaches directly, openclaw's session tools — never pass through the
 * console, so the same rule is applied here. A session is one of:
 *
 *   trusted  a member of the agent's org, a routine run, same-org or connected
 *            delegation, an email the address vouches for, or a session this
 *            runtime didn't open (openclaw's own, e.g. a heartbeat).
 *   public   someone outside the org through a listing: anonymous or
 *            signed-in web chat, anonymous MCP, SMS, an unconnected agent from
 *            another org.
 *   email    inbound email from a stranger: an open address, a personal
 *            assistant's guest, or mail that can't be placed.
 *   phone    a phone call (or the record of one) whose caller hasn't passed
 *            step-up verification (their phone PIN). Caller ID is not proof
 *            of identity, so on its own it never unlocks the owner's tools.
 *
 * An untrusted session keeps an allowlist: the console's minimal set of
 * platform tools (which the console enforces too), the read-only built-ins,
 * and whatever the agent's org opted in for that channel. New tools are
 * refused by default.
 */

export type SessionChannel = "trusted" | "public" | "email" | "phone";

export const UNTRUSTED_CHANNELS = ["public", "email", "phone"] as const;
export type UntrustedChannel = (typeof UNTRUSTED_CHANNELS)[number];

export function isUntrustedChannel(c: SessionChannel): c is UntrustedChannel {
  return c !== "trusted";
}

/** The session a tool call runs in, as the policy sees it. */
export interface SessionVerdict {
  channel: SessionChannel;
  /** The console conversation the session runs in, when known. */
  conversationId: string | null;
  /** The platform task the session executes (`task:<id>`), when it is one. */
  taskId: string | null;
}

/**
 * The boot memory digest (`# MEMORY`), held here instead of in SOUL.md while
 * the rules are enforced, so only trusted sessions get it in their system
 * prompt (bootstrap.ts sets it; the knox-session-policy plugin adds it).
 */
export const bootMemoryDigest: { current: string | null } = { current: null };

/**
 * The runtime's own key on a platform tool call: the session it runs in,
 * stamped by the knox-session-policy plugin and taken off by the shim's
 * console MCP route (platform-mcp-forward.ts) before the console sees it.
 */
export const SESSION_STAMP_PARAM = "_knox_session";

/** The console's session headers (console CONTRACT.md, SEC-023) for a session. */
export function sessionHeaders(session: { conversationId: string | null; taskId: string | null }): Record<string, string> {
  const h: Record<string, string> = {};
  if (session.conversationId) h["X-Agent-Session-Conversation"] = session.conversationId;
  if (session.taskId) h["X-Agent-Session-Task"] = session.taskId;
  return h;
}

// ── session keys ─────────────────────────────────────────

export type SessionKeyKind = "webchat" | "a2a" | "task" | "voice" | "other";

/**
 * What an openclaw session key names. The shim opens `webchat:<conv>`,
 * `a2a:<conv>` and `task:<taskId>`; the voice-call plugin opens `voice:…`.
 * openclaw may prefix any of them (`agent:main:webchat:<conv>`).
 */
export function parseSessionKey(sessionKey: string | null | undefined): {
  kind: SessionKeyKind;
  id: string | null;
} {
  const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
  if (!key) return { kind: "other", id: null };
  const voice = /(?:^|:)(voice:.+)$/.exec(key);
  if (voice) return { kind: "voice", id: voice[1]! };
  const m = /(?:^|:)(webchat|a2a|task):([^:]+)$/.exec(key);
  if (m) return { kind: m[1] as "webchat" | "a2a" | "task", id: m[2]! };
  return { kind: "other", id: null };
}

// ── classifying a conversation (mirrors the console's session-trust.ts) ──

export interface ConversationFacts {
  origin: string | null;
  userId: string | null;
  /** The conversation's user is a member of the agent's org. Ignored without a user. */
  userIsMember: boolean;
  callerAgentUid: string | null;
  /** The calling agent's org, when callerAgentUid is set. */
  callerAgentOrgId: string | null;
  agentOrgId: string;
  delegationConnectionId: string | null;
  driveThroughConnectionId: string | null;
}

/** Origins a person outside the org can open a session through. */
const LISTING_ORIGINS = new Set(["web", "mcp", "sms"]);

/**
 * The channel of a conversation that isn't an email thread or a phone call
 * (classifyEmail / the phone step-up handle those). Public when nobody from
 * the agent's org is behind it.
 */
export function classifyConversation(c: ConversationFacts): SessionChannel {
  if (c.origin === "sms") return "public";
  if (c.callerAgentUid) {
    if (c.delegationConnectionId || c.driveThroughConnectionId) return "trusted";
    return c.callerAgentOrgId === c.agentOrgId ? "trusted" : "public";
  }
  if (c.origin && LISTING_ORIGINS.has(c.origin)) {
    if (!c.userId) return "public";
    return c.userIsMember ? "trusted" : "public";
  }
  if (c.userId && !c.userIsMember) return "public";
  return "trusted";
}

/**
 * An email session's channel: trusted only for mail whose sender the address
 * vouches for (a non-open address), or a personal assistant's own owner.
 */
export function classifyEmail(input: {
  fromEmail: string | null;
  inboundPolicy: string | null;
  personalAssistant: boolean;
  ownerAddresses: Array<string | null>;
}): SessionChannel {
  if (!input.fromEmail) return "email";
  if (input.personalAssistant) {
    const from = input.fromEmail.trim().toLowerCase();
    return input.ownerAddresses.some((a) => a?.trim().toLowerCase() === from) ? "trusted" : "email";
  }
  if (!input.inboundPolicy || input.inboundPolicy === "open") return "email";
  return "trusted";
}

// ── tools ────────────────────────────────────────────────

/** The reserved server name of the console's MCP server (render-workspace.ts). */
export const PLATFORM_SERVER = "knoxville_platform";

/** The step-up tool the session-policy plugin offers on phone calls. */
export const VERIFY_CALLER_TOOL = "verify_caller_pin";

/**
 * Platform tools an untrusted session keeps without an opt-in: the console's
 * own minimal set (console session-trust.ts UNTRUSTED_SESSION_TOOLS). Each
 * answers the person in front of the agent, asks a member for help, or reads
 * what the agent is configured to share.
 */
const PLATFORM_BASE = [
  "escalate_to_human",
  "answer_call_escalation",
  "ask_question",
  "report_outcome",
  "report_task_progress",
  "check_lessons",
  "list_knowledge",
  "read_knowledge",
  "get_artifact",
  "list_my_artifacts",
  "publish_artifact",
  "get_drive_through",
  "search_drive_throughs",
  "resolve_qr_code",
] as const;

const PLATFORM_ALLOWED: Readonly<Record<UntrustedChannel, ReadonlySet<string>>> = {
  public: new Set<string>(PLATFORM_BASE),
  // An email is answered by email (held for sign-off when the sender is outside the org).
  email: new Set<string>([...PLATFORM_BASE, "send_customer_email"]),
  // A caller who hasn't said their PIN can still answer and approve (with the
  // PIN, which the console checks) what work started on the call is waiting on.
  phone: new Set<string>([...PLATFORM_BASE, "list_call_escalations"]),
};

/**
 * Built-in openclaw tools an untrusted session keeps: reading (inside the
 * workspace, not the agent's memory files), web search/fetch, looking at an
 * image or PDF, and its own plan. No exec, no file writes, no other sessions.
 */
const BUILTIN_ALLOWED = new Set(["read", "web_search", "web_fetch", "image", "pdf", "update_plan"]);

/** openclaw's name for a server's tools: `<server>__<tool>` with the server sanitized. */
export function safeServerName(raw: string): string {
  const normalized = raw.trim().replace(/[^A-Za-z0-9_-]/g, "-") || "mcp";
  const safe = /^[A-Za-z]/.test(normalized) ? normalized : `mcp-${normalized}`;
  return safe.length > 30 ? safe.slice(0, 30) : safe;
}

export type ToolClass =
  | { kind: "platform"; tool: string }
  | { kind: "connector"; server: string; tool: string }
  | { kind: "builtin"; tool: string };

/**
 * Where a tool comes from: the console's MCP server, another MCP server the
 * agent reaches directly (`servers`, the OPENCLAW_MCP_SERVERS names), or
 * openclaw itself (and its plugins).
 */
export function classifyTool(toolName: string, servers: readonly string[]): ToolClass {
  const name = toolName.trim();
  const lower = name.toLowerCase();
  const platformPrefix = `${PLATFORM_SERVER}__`;
  if (lower.startsWith(platformPrefix)) return { kind: "platform", tool: name.slice(platformPrefix.length) };
  for (const server of servers) {
    const prefix = `${safeServerName(server)}__`.toLowerCase();
    if (lower.startsWith(prefix) && lower.length > prefix.length) {
      return { kind: "connector", server, tool: name.slice(prefix.length) };
    }
  }
  return { kind: "builtin", tool: name };
}

/**
 * Workspace files that are the agent's memory (agent-memory.ts): its playbook
 * and notes. Not readable from an untrusted session.
 */
const MEMORY_PATHS = ["playbook.md", "notes", "memory"];

/**
 * Whether `read` may open this path from an untrusted session: inside the
 * workspace, and not one of the agent's memory files. Relative paths resolve
 * against the workspace (the agent's working directory).
 */
export function untrustedReadAllowed(path: unknown, workspaceDir: string): boolean {
  if (typeof path !== "string" || !path.trim()) return false;
  const root = resolve(workspaceDir);
  const target = resolve(root, path.trim());
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  const first = rel.split(sep)[0]!.toLowerCase();
  return !MEMORY_PATHS.includes(first);
}

export interface ToolDecisionInput {
  channel: SessionChannel;
  toolName: string;
  params: unknown;
  /** Server names the agent reaches directly (OPENCLAW_MCP_SERVERS). */
  servers: readonly string[];
  /** Tools the agent's org allowed on this channel (console 0280 + env). */
  optIns: ReadonlySet<string>;
  workspaceDir: string;
}

export type ToolDecision = { allow: true } | { allow: false; reason: string };

/** Lower-case name forms an opt-in may use for a tool. */
function optInNames(toolName: string, cls: ToolClass): string[] {
  const names = [toolName.toLowerCase()];
  if (cls.kind === "platform") names.push(cls.tool.toLowerCase());
  return names;
}

/** May a tool call run in a session on this channel? */
export function decideTool(input: ToolDecisionInput): ToolDecision {
  if (!isUntrustedChannel(input.channel)) return { allow: true };
  const cls = classifyTool(input.toolName, input.servers);
  if (optInNames(input.toolName, cls).some((n) => input.optIns.has(n))) return { allow: true };

  if (cls.kind === "platform") {
    if (PLATFORM_ALLOWED[input.channel].has(cls.tool.toLowerCase())) return { allow: true };
  } else if (cls.kind === "builtin") {
    const tool = cls.tool.toLowerCase();
    if (tool === VERIFY_CALLER_TOOL) return { allow: true };
    if (tool === "read") {
      const path = (input.params as { path?: unknown } | null)?.path;
      if (untrustedReadAllowed(path, input.workspaceDir)) return { allow: true };
      return { allow: false, reason: refusal(input.toolName, input.channel, "that file") };
    }
    if (BUILTIN_ALLOWED.has(tool)) return { allow: true };
  }
  return { allow: false, reason: refusal(input.toolName, input.channel) };
}

/** What the agent is told when the session refuses a tool. */
export function refusal(tool: string, channel: UntrustedChannel, what?: string): string {
  if (channel === "phone") {
    return (
      `${what ? `Reading ${what}` : tool} isn't available on this call yet: the caller hasn't confirmed who they ` +
      `are. Ask them for their phone PIN and call ${VERIFY_CALLER_TOOL} with it; until then you can answer ` +
      "questions, read your knowledge and help with what the call is already waiting on."
    );
  }
  const who =
    channel === "public"
      ? "someone outside your organization (a public chat, SMS or MCP visitor)"
      : "an email from someone your address doesn't vouch for";
  return (
    `${what ? `Reading ${what}` : tool} isn't available in this session: it was started by ${who}, so you only ` +
    "have the tools to answer them, read your knowledge, publish a page, report and escalate. If they need " +
    "more, escalate_to_human; an org admin can allow a tool for these sessions."
  );
}

/** Parse an opt-in list (comma / whitespace separated) into lower-case names. */
export function parseToolNames(raw: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const t of (raw ?? "").split(/[\s,]+/)) {
    const v = t.trim().toLowerCase();
    if (v) out.add(v);
  }
  return out;
}
