import { log } from "../log.js";
import type {
  AgentMemoryRow,
  AttachmentRow,
  CallerContextQuery,
  CallerPreferenceRow,
  Conversation,
  InsertAttachmentRow,
  InsertMessageOptions,
  MessageRow,
  UpdateMessageOptions,
} from "../shim/supabase-db.js";
import type { InsertToolCallRow, UpdateToolCallRow } from "../shim/tool-telemetry.js";
import type { AgentDataClient } from "./client.js";

/**
 * MessagingDB over the agent data API: the same methods and the same
 * fail-soft results (null / false / []) as the service-key implementation in
 * shim/supabase-db.ts, which delegates here when the container is scoped.
 * The console checks every row is this agent's own; nothing here can name
 * another agent's or org's data.
 */
export class ScopedMessaging {
  constructor(private readonly api: AgentDataClient) {}

  private async soft<T>(what: string, fallback: T, fn: () => Promise<T>, level: "warn" | "error" = "warn"): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      log[level](`${what} failed`, { err: String(err) });
      return fallback;
    }
  }

  userInOrg(userId: string, _orgId: string): Promise<boolean> {
    // The console checks membership in THIS agent's org, the only org the
    // shim ever asks about.
    return this.soft("userInOrg", false, async () => {
      const r = await this.api.call<{ member: boolean }>("org_member.check", { user_id: userId });
      return r.member === true;
    });
  }

  getConversation(conversationId: string): Promise<Conversation | null> {
    return this.soft("getConversation", null, async () => {
      const r = await this.api.call<{ conversation: Conversation | null }>("conversation.get", {
        conversation_id: conversationId,
      });
      return r.conversation ?? null;
    });
  }

  setConversationTitleIfUnset(conversationId: string, title: string): Promise<boolean> {
    return this.soft("setConversationTitleIfUnset", false, async () => {
      const r = await this.api.call<{ updated: boolean }>("conversation.set_title_if_unset", {
        conversation_id: conversationId,
        title,
      });
      return r.updated === true;
    });
  }

  listMessages(conversationId: string, limit = 500): Promise<MessageRow[]> {
    return this.soft("listMessages", [] as MessageRow[], async () => {
      const r = await this.api.call<{ messages: MessageRow[] }>("messages.list", {
        conversation_id: conversationId,
        limit,
      });
      return r.messages ?? [];
    });
  }

  getCallerContext(q: CallerContextQuery): Promise<CallerPreferenceRow[]> {
    return this.soft("getCallerContext", [] as CallerPreferenceRow[], async () => {
      const r = await this.api.call<{ rows: CallerPreferenceRow[] }>("caller_preferences.list", {
        caller_agent_uid: q.callerAgentUid ?? null,
        caller_org_id: q.callerOrgId ?? null,
        limit: q.limit ?? 8,
      });
      return r.rows ?? [];
    });
  }

  getRecentMemories(_agentUid: string, limit = 5): Promise<AgentMemoryRow[]> {
    return this.soft("getRecentMemories", [] as AgentMemoryRow[], async () => {
      const r = await this.api.call<{ rows: AgentMemoryRow[] }>("memories.recent", { limit });
      return r.rows ?? [];
    });
  }

  insertMessage(opts: InsertMessageOptions): Promise<string | null> {
    return this.soft(
      "insertMessage",
      null,
      async () => {
        const r = await this.api.call<{ id: string }>("messages.insert", {
          conversation_id: opts.conversationId,
          role: opts.role,
          content: opts.content ?? "",
          status: opts.status ?? "complete",
          system_generated: opts.systemGenerated ?? false,
          sender_kind: opts.senderKind ?? "user",
          sender_id: opts.senderId || null,
          parent_message_id: opts.parentMessageId || null,
        });
        return r.id;
      },
      "error",
    );
  }

  updateMessage(messageId: string, opts: UpdateMessageOptions): Promise<boolean> {
    const patch: Record<string, unknown> = {};
    if (opts.content !== undefined) patch.content = opts.content;
    if (opts.status !== undefined) patch.status = opts.status;
    if (opts.completedAt !== undefined) patch.completed_at = opts.completedAt;
    if (opts.tokenUsage !== undefined) patch.token_usage = opts.tokenUsage;
    if (Object.keys(patch).length === 0) return Promise.resolve(true);
    return this.soft(
      "updateMessage",
      false,
      async () => {
        await this.api.call("messages.update", { message_id: messageId, ...patch });
        return true;
      },
      "error",
    );
  }

  saveStreamingContent(messageId: string, content: string): Promise<boolean> {
    return this.soft("saveStreamingContent", false, async () => {
      await this.api.call("messages.update", { message_id: messageId, content, only_streaming: true });
      return true;
    });
  }

  failOrphanedTurns(_agentUid: string): Promise<number> {
    return this.soft("failOrphanedTurns", 0, async () => {
      const r = await this.api.call<{ count: number }>("messages.fail_orphaned");
      return r.count ?? 0;
    });
  }

  insertAttachments(rows: InsertAttachmentRow[]): Promise<AttachmentRow[]> {
    if (rows.length === 0) return Promise.resolve([]);
    return this.soft(
      "insertAttachments",
      [] as AttachmentRow[],
      async () => {
        const r = await this.api.call<{ attachments: AttachmentRow[] }>("attachments.insert", {
          rows: rows as unknown as Record<string, unknown>[],
        });
        return r.attachments ?? [];
      },
      "error",
    );
  }

  async downloadAttachmentBase64(storagePath: string): Promise<string | null> {
    try {
      const { url } = await this.api.call<{ url: string | null }>("attachments.sign", {
        storage_path: storagePath,
      });
      if (!url) return null;
      const res = await this.api.fetchSigned(url);
      if (!res) return null;
      return Buffer.from(await res.arrayBuffer()).toString("base64");
    } catch (err) {
      log.warn("attachment download failed", { storage_path: storagePath, error: String(err) });
      return null;
    }
  }

  listAttachmentsForMessages(messageIds: string[]): Promise<AttachmentRow[]> {
    if (messageIds.length === 0) return Promise.resolve([]);
    return this.soft("listAttachmentsForMessages", [] as AttachmentRow[], async () => {
      const r = await this.api.call<{ attachments: AttachmentRow[] }>("attachments.list", {
        message_ids: messageIds,
      });
      return r.attachments ?? [];
    });
  }

  insertToolCall(row: InsertToolCallRow): Promise<string | null> {
    return this.soft("insertToolCall", null, async () => {
      const r = await this.api.call<{ id: string }>("tool_calls.insert", {
        seq: row.seq,
        tool_name: row.toolName,
        conversation_id: row.conversationId,
        message_id: row.messageId,
        task_id: row.taskId,
        server: row.server,
        tool_call_id: row.toolCallId,
        ...(row.argsPreview !== undefined && row.argsPreview !== null ? { args_preview: row.argsPreview } : {}),
      });
      return r.id;
    });
  }

  updateToolCall(id: string, patch: UpdateToolCallRow): Promise<boolean> {
    const payload: Record<string, unknown> = {};
    if (patch.status !== undefined) payload.status = patch.status;
    if (patch.error !== undefined) payload.error = patch.error;
    if (patch.durationMs !== undefined) payload.duration_ms = patch.durationMs;
    if (patch.completedAt !== undefined) payload.completed_at = patch.completedAt;
    if (Object.keys(payload).length === 0) return Promise.resolve(true);
    return this.soft("updateToolCall", false, async () => {
      await this.api.call("tool_calls.update", { id, ...payload });
      return true;
    });
  }
}
