import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";

/**
 * Storage bucket the console uploads chat attachments into (see
 * knoxville-ai-console migration 0009_messages.sql). Distinct from the
 * `agent-data` bucket used for agent config/memory blobs.
 */
const CHAT_ATTACHMENTS_BUCKET = "chat-attachments";

/**
 * Thin Supabase client for the messaging layer.
 *
 * Bypasses RLS (service-role key), so every method assumes the caller
 * has already validated the bearer JWT and run an org-membership /
 * agent-connection check.
 *
 * Port of app/messaging/supabase_db.py from the original (Python)
 * agent-core. Only the methods the shim actually uses are ported here;
 * keep the names aligned so future ports can copy more in if needed.
 */

export interface Conversation {
  id: string;
  org_id: string;
  agent_uid: string;
  user_id: string | null;
  title: string | null;
  archived_at: string | null;
  kind: string | null;
}

export interface MessageRow {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  status: string;
  system_generated: boolean;
  sender_kind: string | null;
  sender_id: string | null;
  created_at: string;
}

export interface AttachmentRow {
  id: string;
  message_id: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  original_name: string | null;
}

export interface InsertMessageOptions {
  conversationId: string;
  role: "user" | "assistant" | "system" | "tool";
  content?: string;
  status?: string;
  parentMessageId?: string | null;
  systemGenerated?: boolean;
  senderKind?: string;
  senderId?: string | null;
}

export interface UpdateMessageOptions {
  content?: string;
  status?: string;
  completedAt?: string;
  tokenUsage?: Record<string, unknown>;
}

export interface InsertAttachmentRow {
  message_id: string;
  conversation_id: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  original_name?: string;
  width?: number;
  height?: number;
}

/** A callee-owned preference row about a specific calling org/agent, from
 *  `agent_caller_preferences` (console migration 0037). */
export interface CallerPreferenceRow {
  note: string;
  key: string | null;
  relationship: string | null;
  tags: string[] | null;
  salience: number | null;
  pinned: boolean | null;
  last_interaction_at: string | null;
}

/** A durable learned memory row, from `agent_memories` (console migration
 *  0036). Only the fields the per-turn `# RECENT` injection needs. */
export interface AgentMemoryRow {
  title: string | null;
  body: string;
  kind: string | null;
  tags: string[] | null;
}

export interface CallerContextQuery {
  targetAgentUid: string;
  callerAgentUid?: string | null;
  callerOrgId?: string | null;
  limit?: number;
}

export class MessagingDB {
  private readonly client: SupabaseClient;

  constructor(env: AgentEnv) {
    this.client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async userInOrg(userId: string, orgId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("org_members")
      .select("user_id")
      .eq("user_id", userId)
      .eq("org_id", orgId)
      .limit(1);
    if (error) {
      log.warn("userInOrg query failed", { err: error.message });
      return false;
    }
    return (data?.length ?? 0) > 0;
  }

  async getConversation(conversationId: string): Promise<Conversation | null> {
    const { data, error } = await this.client
      .from("conversations")
      .select("id,org_id,agent_uid,user_id,title,archived_at,kind")
      .eq("id", conversationId)
      .limit(1)
      .maybeSingle();
    if (error) {
      log.warn("getConversation query failed", { err: error.message });
      return null;
    }
    return (data as Conversation | null) ?? null;
  }

  async listMessages(conversationId: string, limit = 500): Promise<MessageRow[]> {
    const { data, error } = await this.client
      .from("messages")
      .select(
        "id,role,content,status,system_generated,sender_kind,sender_id,created_at",
      )
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) {
      log.warn("listMessages query failed", { err: error.message });
      return [];
    }
    return (data ?? []) as MessageRow[];
  }

  /**
   * Read what THIS agent has learned about a caller (org and/or agent) from
   * `agent_caller_preferences`. Agent-specific rows and org-level rows (where
   * `caller_agent_uid is null`) are both returned and merged, most-relevant
   * first. All identifiers go through parameterized `.eq()`/`.is()` filters (no
   * PostgREST filter-string interpolation). Fail-open: returns `[]` on any error
   * — including "relation does not exist" before the migration is applied — so a
   * turn never breaks because caller memory isn't available yet.
   */
  async getCallerContext(q: CallerContextQuery): Promise<CallerPreferenceRow[]> {
    const limit = q.limit ?? 8;
    const sel =
      "note,key,relationship,tags,salience,pinned,last_interaction_at";
    const rows: CallerPreferenceRow[] = [];
    try {
      if (q.callerAgentUid) {
        const { data, error } = await this.client
          .from("agent_caller_preferences")
          .select(sel)
          .eq("target_agent_uid", q.targetAgentUid)
          .eq("caller_agent_uid", q.callerAgentUid)
          .order("pinned", { ascending: false })
          .order("salience", { ascending: false })
          .order("last_interaction_at", { ascending: false })
          .limit(limit);
        if (error) {
          log.warn("getCallerContext (agent) failed", { err: error.message });
          return [];
        }
        rows.push(...((data ?? []) as CallerPreferenceRow[]));
      }
      if (q.callerOrgId) {
        const { data, error } = await this.client
          .from("agent_caller_preferences")
          .select(sel)
          .eq("target_agent_uid", q.targetAgentUid)
          .eq("caller_org_id", q.callerOrgId)
          .is("caller_agent_uid", null)
          .order("pinned", { ascending: false })
          .order("salience", { ascending: false })
          .limit(limit);
        if (!error) rows.push(...((data ?? []) as CallerPreferenceRow[]));
      }
    } catch (err) {
      log.warn("getCallerContext threw", { err: String(err) });
      return [];
    }
    // De-dupe by (key ?? note); keep first (most-relevant) occurrence.
    const seen = new Set<string>();
    const deduped: CallerPreferenceRow[] = [];
    for (const r of rows) {
      const id = r.key ?? r.note;
      if (seen.has(id)) continue;
      seen.add(id);
      deduped.push(r);
    }
    return deduped.slice(0, limit);
  }

  /**
   * The agent's most recently written durable memories, for the per-turn
   * `# RECENT` injection — the live path for memory written mid-session, since
   * SOUL's `# MEMORY` digest is only a boot snapshot. Not conversation-scoped:
   * memories written via the `remember` tool are unlinked (an openclaw turn only
   * knows the engine session id, not a public.conversations row), so recency is
   * keyed on the agent, newest first. Fail-open like getCallerContext.
   */
  async getRecentMemories(
    agentUid: string,
    limit = 5,
  ): Promise<AgentMemoryRow[]> {
    try {
      const { data, error } = await this.client
        .from("agent_memories")
        .select("title,body,kind,tags")
        .eq("agent_uid", agentUid)
        .is("superseded_by", null)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) {
        log.warn("getRecentMemories failed", { err: error.message });
        return [];
      }
      return (data ?? []) as AgentMemoryRow[];
    } catch (err) {
      log.warn("getRecentMemories threw", { err: String(err) });
      return [];
    }
  }

  async insertMessage(opts: InsertMessageOptions): Promise<string | null> {
    const row: Record<string, unknown> = {
      conversation_id: opts.conversationId,
      role: opts.role,
      content: opts.content ?? "",
      status: opts.status ?? "complete",
      system_generated: opts.systemGenerated ?? false,
      sender_kind: opts.senderKind ?? "user",
    };
    if (opts.senderId) row.sender_id = opts.senderId;
    if (opts.parentMessageId) row.parent_message_id = opts.parentMessageId;
    const { data, error } = await this.client
      .from("messages")
      .insert(row)
      .select("id")
      .single();
    if (error) {
      log.error("insertMessage failed", { err: error.message });
      return null;
    }
    return (data as { id: string }).id;
  }

  async updateMessage(
    messageId: string,
    opts: UpdateMessageOptions,
  ): Promise<boolean> {
    const payload: Record<string, unknown> = {};
    if (opts.content !== undefined) payload.content = opts.content;
    if (opts.status !== undefined) payload.status = opts.status;
    if (opts.completedAt !== undefined) payload.completed_at = opts.completedAt;
    if (opts.tokenUsage !== undefined) payload.token_usage = opts.tokenUsage;
    if (Object.keys(payload).length === 0) return true;
    const { error } = await this.client
      .from("messages")
      .update(payload)
      .eq("id", messageId);
    if (error) {
      log.error("updateMessage failed", { err: error.message });
      return false;
    }
    return true;
  }

  async insertAttachments(
    rows: InsertAttachmentRow[],
  ): Promise<AttachmentRow[]> {
    if (rows.length === 0) return [];
    const { data, error } = await this.client
      .from("message_attachments")
      .insert(rows)
      .select(
        "id,message_id,storage_path,mime_type,size_bytes,width,height,original_name",
      );
    if (error) {
      log.error("insertAttachments failed", { err: error.message });
      return [];
    }
    return (data ?? []) as AttachmentRow[];
  }

  /**
   * Download a chat attachment's raw bytes from the `chat-attachments`
   * bucket and return them base64-encoded, ready to splice into an OpenAI
   * `image_url` data URL. `storagePath` is the bucket-relative key stored on
   * the message_attachments row (e.g.
   * `orgs/{org}/conversations/{conv}/{rand}.png`).
   *
   * Returns null on any failure (missing object, transport error) so the
   * caller can degrade gracefully to text-only rather than failing the turn.
   */
  async downloadAttachmentBase64(storagePath: string): Promise<string | null> {
    const { data, error } = await this.client.storage
      .from(CHAT_ATTACHMENTS_BUCKET)
      .download(storagePath);
    if (error || !data) {
      log.warn("attachment download failed", {
        storage_path: storagePath,
        error: error?.message,
      });
      return null;
    }
    try {
      const buf = Buffer.from(await data.arrayBuffer());
      return buf.toString("base64");
    } catch (err) {
      log.warn("attachment decode failed", {
        storage_path: storagePath,
        err: String(err),
      });
      return null;
    }
  }

  async listAttachmentsForMessages(
    messageIds: string[],
  ): Promise<AttachmentRow[]> {
    if (messageIds.length === 0) return [];
    const { data, error } = await this.client
      .from("message_attachments")
      .select(
        "id,message_id,storage_path,mime_type,size_bytes,width,height,original_name",
      )
      .in("message_id", messageIds);
    if (error) {
      log.warn("listAttachmentsForMessages query failed", { err: error.message });
      return [];
    }
    return (data ?? []) as AttachmentRow[];
  }
}
