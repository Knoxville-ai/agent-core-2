import { join } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import {
  classifyConversation,
  classifyEmail,
  decideTool,
  isUntrustedChannel,
  parseSessionKey,
  parseToolNames,
  type SessionChannel,
  type SessionVerdict,
  type ToolDecision,
  type UntrustedChannel,
} from "./session-policy.js";

/**
 * The session rules (session-policy.ts) with their reads: which channel a
 * session key is on, cached briefly, and the tools the agent's org opted in
 * for that channel. Every read that fails is judged untrusted — a session we
 * can't place is a stranger's.
 */

export interface ConversationRow {
  id: string;
  org_id: string;
  agent_uid: string;
  user_id: string | null;
  origin: string | null;
  caller_agent_uid: string | null;
  delegation_connection_id: string | null;
  drive_through_connection_id: string | null;
}

/** The reads the rules need. Injectable for tests. */
export interface SessionTrustStore {
  conversation(id: string): Promise<ConversationRow | null>;
  isMember(orgId: string, userId: string): Promise<boolean>;
  agentOrg(agentUid: string): Promise<string | null>;
  /** The inbound email that last continued an email session, and its address's policy. */
  latestInboundEmail(conversationId: string): Promise<{ fromEmail: string | null; inboundPolicy: string | null } | null>;
  userAddresses(userId: string): Promise<Array<string | null>>;
  task(taskId: string): Promise<{ agentUid: string; conversationId: string | null } | null>;
  /** Tools beyond the minimal set this agent may use on a channel (console 0280). */
  optIns(agentUid: string, channel: "public" | "email"): Promise<Set<string>>;
}

/** The phone step-up, as the rules see it (../voice/step-up.ts). */
export interface PhoneVerification {
  conversationFor(sessionKey: string): string | null;
  isVerified(conversationId: string | null | undefined): boolean;
  /** This process's call mirror made the conversation: a phone call's record. */
  isPhoneConversation?(conversationId: string): boolean;
}

export type PolicyMode = "enforce" | "audit" | "off";

export interface SessionPolicyDeps {
  agentUid: string;
  agentOrg: string;
  store: SessionTrustStore;
  phone?: PhoneVerification | null;
  /**
   * Scoped data mode (no database key): the store sees only what the agent
   * data API returns (no origin, caller agent, inbound email or task rows), so
   * a conversation whose latest turn came from someone outside the org (see
   * noteCaller) is judged public whatever else it looks like.
   */
  scoped?: boolean;
  /** MCP servers the agent reaches directly (OPENCLAW_MCP_SERVERS keys). */
  servers: readonly string[];
  workspaceDir: string;
  /** Operator opt-ins (AGENT_UNTRUSTED_SESSION_TOOLS): `tool` or `channel:tool`. */
  envOptIns?: string | null;
  mode?: PolicyMode;
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 30_000;

export class SessionPolicyService {
  private readonly channels = new Map<string, { channel: SessionChannel; at: number }>();
  private readonly optInCache = new Map<string, { names: Set<string>; at: number }>();
  private readonly envOptIns: Map<string, Set<string>>;
  private readonly tasks = new Map<string, { agentUid: string; conversationId: string | null }>();
  private readonly outsideCallers = new Set<string>();

  constructor(private readonly deps: SessionPolicyDeps) {
    this.envOptIns = parseEnvOptIns(deps.envOptIns);
  }

  /** Scoped data mode (see SessionPolicyDeps.scoped). */
  get scoped(): boolean {
    return this.deps.scoped === true;
  }

  get mode(): PolicyMode {
    return this.deps.mode ?? "enforce";
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private ttl(): number {
    return this.deps.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** Drop what's cached for a conversation, e.g. when a new turn arrives on it. */
  forgetConversation(conversationId: string): void {
    this.channels.delete(`c:${conversationId}`);
  }

  /** The conversation a task runs in, as the task's start told the runner. */
  rememberTask(taskId: string, conversationId: string | null): void {
    this.tasks.set(taskId, { agentUid: this.deps.agentUid, conversationId });
    if (this.tasks.size > 2000) this.tasks.delete(this.tasks.keys().next().value!);
  }

  /** Who sent a conversation's latest turn: an org member (or same-org agent) or not. */
  noteCaller(conversationId: string, fromOrg: boolean): void {
    if (fromOrg) this.outsideCallers.delete(conversationId);
    else this.outsideCallers.add(conversationId);
    if (this.outsideCallers.size > 5000) this.outsideCallers.delete(this.outsideCallers.values().next().value!);
    this.forgetConversation(conversationId);
  }

  /** The session a key names, and the channel it is on. */
  async session(sessionKey: string | null | undefined): Promise<SessionVerdict> {
    const { kind, id } = parseSessionKey(sessionKey);
    if (kind === "voice") {
      const conversationId = this.deps.phone?.conversationFor(sessionKey ?? "") ?? null;
      const verified = !!conversationId && !!this.deps.phone?.isVerified(conversationId);
      return { channel: verified ? "trusted" : "phone", conversationId, taskId: null };
    }
    if (kind === "webchat" || kind === "a2a") {
      return { channel: await this.conversationChannel(id!), conversationId: id, taskId: null };
    }
    if (kind === "task") {
      try {
        // Which conversation a task runs in never changes: remembered.
        let task = this.tasks.get(id!) ?? null;
        if (!task) {
          task = await this.deps.store.task(id!);
          if (task) {
            this.tasks.set(id!, task);
            if (this.tasks.size > 2000) this.tasks.delete(this.tasks.keys().next().value!);
          }
        }
        if (!task || task.agentUid !== this.deps.agentUid) {
          return { channel: "public", conversationId: null, taskId: id };
        }
        // A task with no conversation was started with no session behind it;
        // untrusted sessions can't start tasks, so it is the agent's own work.
        if (!task.conversationId) return { channel: "trusted", conversationId: null, taskId: id };
        return { channel: await this.conversationChannel(task.conversationId), conversationId: task.conversationId, taskId: id };
      } catch (err) {
        log.warn("session policy: task lookup failed", { err: String(err) });
        return { channel: "public", conversationId: null, taskId: id };
      }
    }
    // A session this runtime didn't open (openclaw's own). Untrusted sessions
    // can't spawn sessions, so nothing outside the org drives one of these.
    return { channel: "trusted", conversationId: null, taskId: null };
  }

  private async conversationChannel(conversationId: string): Promise<SessionChannel> {
    const key = `c:${conversationId}`;
    const cached = this.channels.get(key);
    // A phone call's verification changes mid-call, so it is never cached.
    if (cached && cached.channel !== "phone" && this.now() - cached.at < this.ttl()) return cached.channel;
    let channel: SessionChannel;
    try {
      channel = await this.classify(conversationId);
    } catch (err) {
      log.warn("session policy: conversation lookup failed", { conversation_id: conversationId, err: String(err) });
      return "public";
    }
    this.channels.set(key, { channel, at: this.now() });
    if (this.channels.size > 2000) this.channels.delete(this.channels.keys().next().value!);
    return channel;
  }

  private async classify(conversationId: string): Promise<SessionChannel> {
    const { store } = this.deps;
    // A call this process mirrored is a phone call, whatever the store sees.
    if (this.deps.phone?.isPhoneConversation?.(conversationId)) {
      return this.deps.phone.isVerified(conversationId) ? "trusted" : "phone";
    }
    const c = await store.conversation(conversationId);
    if (!c || c.agent_uid !== this.deps.agentUid) return "public";
    if (this.deps.scoped && this.outsideCallers.has(c.id)) return "public";
    if (c.origin === "phone") {
      return this.deps.phone?.isVerified(c.id) ? "trusted" : "phone";
    }
    if (c.origin === "email") {
      const inbound = await store.latestInboundEmail(c.id);
      const ownerAddresses = c.user_id ? await store.userAddresses(c.user_id) : [];
      return classifyEmail({
        fromEmail: inbound?.fromEmail ?? null,
        inboundPolicy: inbound?.inboundPolicy ?? null,
        personalAssistant: !!c.user_id,
        ownerAddresses,
      });
    }
    const [userIsMember, callerAgentOrgId] = await Promise.all([
      c.user_id ? store.isMember(c.org_id, c.user_id) : Promise.resolve(false),
      c.caller_agent_uid ? store.agentOrg(c.caller_agent_uid) : Promise.resolve(null),
    ]);
    return classifyConversation({
      origin: c.origin,
      userId: c.user_id,
      userIsMember,
      callerAgentUid: c.caller_agent_uid,
      callerAgentOrgId,
      agentOrgId: c.org_id,
      delegationConnectionId: c.delegation_connection_id,
      driveThroughConnectionId: c.drive_through_connection_id,
    });
  }

  private async optIns(channel: UntrustedChannel): Promise<Set<string>> {
    const names = new Set<string>([...(this.envOptIns.get("*") ?? []), ...(this.envOptIns.get(channel) ?? [])]);
    if (channel === "phone") return names;
    const cached = this.optInCache.get(channel);
    if (cached && this.now() - cached.at < this.ttl() * 2) {
      for (const n of cached.names) names.add(n);
      return names;
    }
    let rows = new Set<string>();
    try {
      rows = await this.deps.store.optIns(this.deps.agentUid, channel);
    } catch (err) {
      // No opt-ins on a failed read: the minimal set only.
      log.warn("session policy: opt-in lookup failed", { err: String(err) });
    }
    const lowered = new Set([...rows].map((n) => n.toLowerCase()));
    this.optInCache.set(channel, { names: lowered, at: this.now() });
    for (const n of lowered) names.add(n);
    return names;
  }

  /**
   * May this tool call run in this session? In audit mode a refusal is logged
   * and the call allowed; off allows everything.
   */
  async decide(
    sessionKey: string | null | undefined,
    toolName: string,
    params: unknown,
  ): Promise<{ decision: ToolDecision; session: SessionVerdict }> {
    const session = await this.session(sessionKey);
    if (this.mode === "off" || !isUntrustedChannel(session.channel)) {
      return { decision: { allow: true }, session };
    }
    const decision = decideTool({
      channel: session.channel,
      toolName,
      params,
      servers: this.deps.servers,
      optIns: await this.optIns(session.channel),
      workspaceDir: this.deps.workspaceDir,
    });
    if (!decision.allow) {
      log.info("session policy refused a tool", {
        session_key: sessionKey ?? null,
        channel: session.channel,
        tool: toolName,
        mode: this.mode,
      });
      if (this.mode === "audit") return { decision: { allow: true }, session };
    }
    return { decision, session };
  }
}

/** `exec, public:write, email:send_email` → channel → names (`*` = every channel). */
export function parseEnvOptIns(raw: string | null | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const token of parseToolNames(raw)) {
    const m = /^(public|email|phone):(.+)$/.exec(token);
    const channel = m ? m[1]! : "*";
    const name = m ? m[2]! : token;
    const set = out.get(channel) ?? new Set<string>();
    set.add(name);
    out.set(channel, set);
  }
  return out;
}

/** The reads, through the service role (the same client the shim's MessagingDB uses). */
export class SupabaseSessionTrustStore implements SessionTrustStore {
  private readonly client: SupabaseClient;

  constructor(env: AgentEnv, client?: SupabaseClient) {
    this.client =
      client ??
      createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
  }

  async conversation(id: string): Promise<ConversationRow | null> {
    const { data, error } = await this.client
      .from("conversations")
      .select("id, org_id, agent_uid, user_id, origin, caller_agent_uid, delegation_connection_id, drive_through_connection_id")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`conversations: ${error.message}`);
    return (data as ConversationRow | null) ?? null;
  }

  async isMember(orgId: string, userId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("org_members")
      .select("user_id")
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .limit(1);
    if (error) throw new Error(`org_members: ${error.message}`);
    return (data?.length ?? 0) > 0;
  }

  async agentOrg(agentUid: string): Promise<string | null> {
    const { data, error } = await this.client.from("agents").select("org_id").eq("id", agentUid).maybeSingle();
    if (error) throw new Error(`agents: ${error.message}`);
    return (data as { org_id: string | null } | null)?.org_id ?? null;
  }

  async latestInboundEmail(conversationId: string): Promise<{ fromEmail: string | null; inboundPolicy: string | null } | null> {
    const { data, error } = await this.client
      .from("agent_inbound_emails")
      .select("from_email, address_id")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`agent_inbound_emails: ${error.message}`);
    const row = data as { from_email: string | null; address_id: string | null } | null;
    if (!row) return null;
    let inboundPolicy: string | null = null;
    if (row.address_id) {
      const { data: addr, error: addrError } = await this.client
        .from("email_addresses")
        .select("inbound_policy")
        .eq("id", row.address_id)
        .maybeSingle();
      if (addrError) throw new Error(`email_addresses: ${addrError.message}`);
      inboundPolicy = (addr as { inbound_policy: string | null } | null)?.inbound_policy ?? null;
    }
    return { fromEmail: row.from_email, inboundPolicy };
  }

  async userAddresses(userId: string): Promise<Array<string | null>> {
    const { data, error } = await this.client.from("users").select("email, notify_email").eq("id", userId).maybeSingle();
    if (error) throw new Error(`users: ${error.message}`);
    const u = data as { email: string | null; notify_email: string | null } | null;
    return u ? [u.email, u.notify_email] : [];
  }

  async task(taskId: string): Promise<{ agentUid: string; conversationId: string | null } | null> {
    const { data, error } = await this.client
      .from("mcp_tasks")
      .select("agent_uid, conversation_id")
      .eq("id", taskId)
      .maybeSingle();
    if (error) throw new Error(`mcp_tasks: ${error.message}`);
    const row = data as { agent_uid: string; conversation_id: string | null } | null;
    return row ? { agentUid: row.agent_uid, conversationId: row.conversation_id } : null;
  }

  async optIns(agentUid: string, channel: "public" | "email"): Promise<Set<string>> {
    const { data, error } = await this.client
      .from("agent_untrusted_session_tools")
      .select("tool_name")
      .eq("agent_uid", agentUid)
      .eq("channel", channel);
    // Before console 0280 the table doesn't exist: no opt-ins.
    if (error) return new Set();
    return new Set(((data ?? []) as Array<{ tool_name: string }>).map((r) => r.tool_name.toLowerCase()));
  }
}

/** What scopedSessionTrustStore reads through: the shim's MessagingDB on its scoped path. */
export interface ScopedReads {
  getConversation(id: string): Promise<{
    id: string;
    org_id: string;
    agent_uid: string;
    user_id: string | null;
    drive_through_connection_id: string | null;
    delegation_connection_id?: string | null;
  } | null>;
  userInOrg(userId: string, orgId: string): Promise<boolean>;
}

/**
 * The reads in scoped data mode, through the console's agent data API
 * (`conversation.get`, `org_member.check`). The API has no operation yet for a
 * conversation's origin and caller agent, inbound email, task rows or the
 * opt-in table, so: the origin is unknown (the turn's caller fills the gap,
 * SessionPolicyService.noteCaller), a task is known only from the runner
 * (rememberTask) and is otherwise untrusted, and there are no opt-ins.
 */
export function scopedSessionTrustStore(db: ScopedReads): SessionTrustStore {
  return {
    async conversation(id) {
      const c = await db.getConversation(id);
      if (!c) return null;
      return {
        id: c.id,
        org_id: c.org_id,
        agent_uid: c.agent_uid,
        user_id: c.user_id,
        origin: null,
        caller_agent_uid: null,
        delegation_connection_id: c.delegation_connection_id ?? null,
        drive_through_connection_id: c.drive_through_connection_id,
      };
    },
    isMember: (orgId, userId) => db.userInOrg(userId, orgId),
    agentOrg: async () => null,
    latestInboundEmail: async () => null,
    userAddresses: async () => [],
    task: async () => {
      throw new Error("task lookup needs the database key or a console operation");
    },
    optIns: async () => new Set(),
  };
}

/** The direct MCP server names from OPENCLAW_MCP_SERVERS (never the platform one). */
export function directServerNames(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.keys(parsed).filter((n) => n !== "knoxville_platform");
  } catch {
    return [];
  }
}

/** The agent's working directory (relative tool paths resolve against it). */
export function workspaceDirOf(env: Pick<AgentEnv, "OPENCLAW_STATE_DIR">): string {
  return join(env.OPENCLAW_STATE_DIR, "workspace");
}
