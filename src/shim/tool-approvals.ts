import { createHash, createHmac } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { BundleClient } from "../bundle/client.js";
import { classifyTool, SESSION_STAMP_PARAM, sessionHeaders, type SessionVerdict, type ToolDecision } from "./session-policy.js";

/**
 * "Requires approval" on tools of MCP servers the agent reaches directly
 * (SEC-019). The console marks a connector tool as needing a person's approval
 * for every call and delivers the list as OPENCLAW_TOOLS_ESCALATE
 * (`<server>__<tool>`). A connector the console hosts checks the approval
 * itself (console src/lib/integrations/shared/approval-gate.ts). A server the
 * agent reaches directly can't, so the runtime does, fail-closed:
 *
 *   1. The call is held. The runtime asks for approval with the console's own
 *      escalation flow (escalate_to_human, kind "approval", Approve / Deny),
 *      writing the question itself: the tool, the server and every argument,
 *      plus a reference bound to exactly that call (an HMAC the model can't
 *      compute). The session is parked as for any escalation.
 *   2. Once a person approves, the agent calls the tool again with exactly the
 *      same arguments. The runtime finds the approval by its reference, checks
 *      it was answered "Approve" within 24 hours, and uses it up with a
 *      compare-and-set on `escalations.tool_approval_used_at` — one approval,
 *      one call, as for console tools (console 0166).
 *   3. Anything else — waiting, denied, too old, too long to show in full, a
 *      lookup that fails — refuses the call.
 */

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
/** The longest arguments shown to the person approving (the escalation's context is capped at 4000). */
export const APPROVAL_ARGUMENTS_MAX = 3_000;

/** JSON with keys sorted at every level (console approval-rules.ts canonicalJson). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** The call's arguments as approved: the runtime's own stamp left out. */
export function approvalArgs(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) return {};
  const { [SESSION_STAMP_PARAM]: _stamp, ...rest } = params as Record<string, unknown>;
  return rest;
}

/** Whether the answer approves: the Approve option, optionally followed by a note. */
export function answerApproves(answerText: string | null | undefined): boolean {
  const a = (answerText ?? "").trim();
  if (!a) return false;
  const comma = a.indexOf(",");
  return (comma === -1 ? a : a.slice(0, comma)).trim().toLowerCase() === "approve";
}

/** The reference that binds an approval to one call by this agent. */
export function approvalReference(key: string, agentUid: string, tool: string, args: unknown): string {
  const mac = createHmac("sha256", key).update(`${agentUid}\n${tool}\n${canonicalJson(args)}`).digest("hex");
  return `knox-approval:${mac.slice(0, 40)}`;
}

/** The approval key, derived from the gateway token (stable per agent, never shown to the model). */
export function approvalKey(gatewayToken: string): string {
  return createHash("sha256").update(`knox-tool-approval\n${gatewayToken}`).digest("hex");
}

export interface ApprovalRow {
  id: string;
  state: string;
  answer_text: string | null;
  resolved_at: string | null;
}

export interface ApprovalStore {
  /** Unused approval escalations of this agent whose context carries the reference, newest first. */
  find(agentUid: string, reference: string): Promise<ApprovalRow[]>;
  /** Use the approval up; false when another call got there first. */
  claim(id: string): Promise<boolean>;
}

export interface ApprovalAsker {
  /** Raise the approval escalation in this session; its id. */
  ask(input: { session: SessionVerdict; title: string; question: string; context: string }): Promise<string>;
}

export interface ToolApprovalDeps {
  agentUid: string;
  /** OPENCLAW_TOOLS_ESCALATE tokens (`<server>__<tool>`). */
  escalated: readonly string[];
  /** Direct MCP server names (OPENCLAW_MCP_SERVERS keys). */
  servers: readonly string[];
  /** Servers the console hosts, which check their approvals themselves. */
  consoleHosted: ReadonlySet<string>;
  key: string;
  store: ApprovalStore | null;
  asker: ApprovalAsker | null;
  now?: () => number;
}

export class ToolApprovalGate {
  private readonly escalated: Set<string>;

  constructor(private readonly deps: ToolApprovalDeps) {
    this.escalated = new Set(deps.escalated.map((t) => t.trim().toLowerCase()).filter(Boolean));
  }

  /** The `<server>__<tool>` token of a direct connector tool, when it needs approval here. */
  gatedToken(toolName: string): { token: string; server: string } | null {
    if (this.escalated.size === 0) return null;
    const cls = classifyTool(toolName, this.deps.servers);
    if (cls.kind !== "connector") return null;
    if (this.deps.consoleHosted.has(cls.server)) return null;
    const token = `${cls.server}__${cls.tool}`;
    return this.escalated.has(token.toLowerCase()) ? { token, server: cls.server } : null;
  }

  async check(toolName: string, params: unknown, session: SessionVerdict): Promise<ToolDecision> {
    const gated = this.gatedToken(toolName);
    if (!gated) return { allow: true };
    const { token, server } = gated;
    const args = approvalArgs(params);
    const shown = JSON.stringify(sortKeys(args), null, 2) ?? "{}";
    if (shown.length > APPROVAL_ARGUMENTS_MAX) {
      return {
        allow: false,
        reason:
          `${token} needs a person's approval for every call, and these arguments are too long ` +
          `(${shown.length} characters) to show them in full. Shorten the call or split it, then call it again.`,
      };
    }
    if (!this.deps.store || !this.deps.asker) {
      return { allow: false, reason: `${token} needs a person's approval, and this agent can't check one. It wasn't run.` };
    }
    const reference = approvalReference(this.deps.key, this.deps.agentUid, token, args);
    try {
      const rows = await this.deps.store.find(this.deps.agentUid, reference);
      const now = (this.deps.now ?? Date.now)();
      const answered = (r: ApprovalRow) => r.state === "answered" || r.state === "resolved";
      const fresh = (r: ApprovalRow) => !!r.resolved_at && now - Date.parse(r.resolved_at) <= APPROVAL_TTL_MS;
      const approved = rows.find((r) => answered(r) && fresh(r) && answerApproves(r.answer_text));
      if (approved) {
        if (await this.deps.store.claim(approved.id)) {
          log.info("tool approval used", { tool: token, escalation_id: approved.id });
          return { allow: true };
        }
        return { allow: false, reason: `That approval for ${token} was just used by another call. Call it again to ask for a new one.` };
      }
      const waiting = rows.find((r) => r.state === "pending" || r.state === "assigned");
      if (waiting) {
        return {
          allow: false,
          reason: `Your approval request for this ${token} call (${waiting.id}) hasn't been answered yet. End your turn; you'll be woken with the answer.`,
        };
      }
      const denied = rows.find((r) => answered(r) && fresh(r) && !answerApproves(r.answer_text));
      if (denied) {
        return {
          allow: false,
          reason: `This ${token} call wasn't approved (answer: "${(denied.answer_text ?? "").trim()}"). Don't run it.`,
        };
      }
      if (!session.conversationId && !session.taskId) {
        return { allow: false, reason: `${token} needs a person's approval, which can't be asked for from this session. It wasn't run.` };
      }
      const escalationId = await this.deps.asker.ask({
        session,
        title: `Approve ${token}`.slice(0, 80),
        question: `Allow the agent to run ${token} once, with exactly the arguments shown?`,
        context:
          `The agent wants to run \`${token}\` on ${server}. An admin set this tool to need a person's approval ` +
          "for every call. It runs once, with exactly these arguments, only if you approve:\n\n" +
          "```json\n" +
          `${shown}\n` +
          "```\n\n" +
          `Approval reference: \`${reference}\``,
      });
      log.info("tool approval requested", { tool: token, escalation_id: escalationId });
      return {
        allow: false,
        reason:
          `${token} needs a person's approval for every call, so it wasn't run. Approval was requested ` +
          `(${escalationId}) and your work is on hold: end your turn now. When you're woken with an ` +
          `[escalation-answer] that approves it, call ${token} again with exactly the same arguments. ` +
          "If it's denied, don't run it.",
      };
    } catch (err) {
      log.warn("tool approval check failed", { tool: token, err: String(err) });
      return {
        allow: false,
        reason: `${token} needs a person's approval, and it couldn't be checked just now, so it wasn't run. Try again shortly.`,
      };
    }
  }
}

/** The approval rows, through the service role. */
export class SupabaseApprovalStore implements ApprovalStore {
  private readonly client: SupabaseClient;

  constructor(env: AgentEnv, client?: SupabaseClient) {
    this.client =
      client ??
      createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
  }

  async find(agentUid: string, reference: string): Promise<ApprovalRow[]> {
    const { data, error } = await this.client
      .from("escalations")
      .select("id, state, answer_text, resolved_at")
      .eq("origin_agent_uid", agentUid)
      .eq("kind", "approval")
      .is("tool_name", null)
      .is("tool_approval_used_at", null)
      .like("context", `%${reference}%`)
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw new Error(`escalations: ${error.message}`);
    return (data ?? []) as ApprovalRow[];
  }

  async claim(id: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("escalations")
      .update({ tool_approval_used_at: new Date().toISOString() })
      .eq("id", id)
      .is("tool_approval_used_at", null)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(`escalations claim: ${error.message}`);
    return !!data;
  }
}

/** Asks through the console's escalate_to_human, as the session's own call would. */
export class PlatformApprovalAsker implements ApprovalAsker {
  constructor(private readonly env: Pick<AgentEnv, "PLATFORM_MCP_URL" | "PLATFORM_API_TOKEN">) {}

  async ask(input: { session: SessionVerdict; title: string; question: string; context: string }): Promise<string> {
    if (!this.env.PLATFORM_MCP_URL || !this.env.PLATFORM_API_TOKEN) throw new Error("platform MCP not configured");
    const client = new BundleClient({ url: this.env.PLATFORM_MCP_URL, token: this.env.PLATFORM_API_TOKEN, timeoutMs: 10_000 });
    const result = await client.callTool(
      "escalate_to_human",
      {
        ...(input.session.taskId ? { task_id: input.session.taskId } : { conversation_id: input.session.conversationId }),
        kind: "approval",
        title: input.title,
        context: input.context,
        questions: [
          {
            header: "Run tool?",
            question: input.question,
            multiSelect: false,
            options: [
              { label: "Approve", description: "Run it once, as shown. A different call needs a new approval." },
              { label: "Deny", description: "Don't run it." },
            ],
          },
        ],
        allowOther: true,
      },
      sessionHeaders(input.session),
    );
    const id = (result.structuredContent as { escalation_id?: unknown } | undefined)?.escalation_id;
    if (result.isError || typeof id !== "string") {
      const msg = result.content?.find((c) => c.type === "text")?.text ?? "escalation not raised";
      throw new Error(msg);
    }
    return id;
  }
}

/**
 * Servers the console hosts: their URL is under the console MCP's own
 * (`${PLATFORM_MCP_URL}/<provider>/<connection>`, as the console writes it,
 * or the same URL spelled out). Those check their approvals themselves.
 */
export function consoleHostedServers(rawServers: string | undefined, platformMcpUrl: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!rawServers?.trim() || !platformMcpUrl) return out;
  let base: URL;
  try {
    base = new URL(platformMcpUrl);
  } catch {
    return out;
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  let parsed: Record<string, { url?: unknown }>;
  try {
    parsed = JSON.parse(rawServers) as Record<string, { url?: unknown }>;
  } catch {
    return out;
  }
  for (const [name, cfg] of Object.entries(parsed ?? {})) {
    if (typeof cfg?.url !== "string") continue;
    const expanded = cfg.url.replace("${PLATFORM_MCP_URL}", platformMcpUrl.replace(/\/+$/, ""));
    try {
      const u = new URL(expanded);
      if (u.origin === base.origin && u.pathname.startsWith(`${basePath}/`)) out.add(name);
    } catch {
      /* not a URL: a direct server */
    }
  }
  return out;
}
