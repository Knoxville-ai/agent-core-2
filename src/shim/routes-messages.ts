import type { IncomingMessage, ServerResponse } from "node:http";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { HttpError, type Principal } from "./auth.js";
import type { CancelRegistry } from "./cancel-registry.js";
import { lookupCapabilities, type ModelCapabilities } from "./model-capabilities.js";
import type {
  AttachmentRow,
  InsertAttachmentRow,
  MessageRow,
  MessagingDB,
} from "./supabase-db.js";
import { readJsonBody } from "./util.js";

/**
 * POST /api/v1/conversations/:id/messages
 *
 * Ports app/messaging/api.py send_message from the original (Python)
 * agent-core. Same wire contract:
 *
 *   request body  : { content: string, attachments?: AttachmentInput[] }
 *
 *   response body : SSE stream with data-only frames, one JSON object per
 *                   `data:` line:
 *     { type: "start", user_message_id, assistant_message_id }
 *     { type: "token", delta }
 *     { type: "done",  status: "complete"|"interrupted", message_id }
 *     { type: "error", error }
 *
 * Persists the user turn + reserves an assistant row before calling
 * openclaw's /v1/chat/completions endpoint, streams deltas into the
 * row, and updates the row's status + final content on done.
 */

interface AttachmentInput {
  storage_path?: unknown;
  mime_type?: unknown;
  size_bytes?: unknown;
  original_name?: unknown;
  width?: unknown;
  height?: unknown;
}

interface MessageRequestBody {
  content?: unknown;
  attachments?: unknown;
}

export interface MessagesDeps {
  env: AgentEnv;
  db: MessagingDB;
  cancels: CancelRegistry;
}

export async function handleSendMessage(
  conversationId: string,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  deps: MessagesDeps,
): Promise<void> {
  const { env, db, cancels } = deps;

  const conversation = await authorizeConversation(conversationId, principal, db, env);

  if (conversation.archived_at) {
    throw new HttpError(409, "conversation archived");
  }

  const body = (await readJsonBody<MessageRequestBody>(req)) ?? {};
  const content =
    typeof body.content === "string" ? body.content.trim() : "";
  const attachmentsRaw = Array.isArray(body.attachments)
    ? (body.attachments as AttachmentInput[])
    : [];

  if (!content && attachmentsRaw.length === 0) {
    throw new HttpError(400, "content or attachments required");
  }

  const isAgentCaller = principal.kind === "agent";
  const senderKind = isAgentCaller ? "agent" : "user";
  const senderId =
    principal.kind === "agent" ? principal.agentUid : principal.userId;

  // 1. Persist the user turn.
  const userMessageId = await db.insertMessage({
    conversationId,
    role: "user",
    content,
    status: "complete",
    senderKind,
    senderId,
  });
  if (!userMessageId) {
    throw new HttpError(500, "failed to persist user message");
  }

  // 2. Link attachments to the user message.
  const insertedAttachments = await persistAttachments(
    db,
    userMessageId,
    conversationId,
    env.AGENT_ORG,
    attachmentsRaw,
  );

  // 3. Model capabilities + warning for dropped attachment types.
  const caps = lookupCapabilities(env.LLM_PROVIDER, env.LLM_MODEL);
  const warning = fallbackNote(insertedAttachments, caps, env.LLM_PROVIDER, env.LLM_MODEL);
  if (warning) {
    await db.insertMessage({
      conversationId,
      role: "assistant",
      content: warning,
      status: "complete",
      systemGenerated: true,
      senderKind: "system",
      senderId: env.AGENT_UID,
    });
  }

  // 4. Reload history (including the just-inserted user row) and build
  //    OpenAI-format messages for the upstream call.
  const history = await db.listMessages(conversationId);
  const historyIds = history.map((r) => r.id);
  const allAttachments = await db.listAttachmentsForMessages(historyIds);
  const attsByMessage = new Map<string, AttachmentRow[]>();
  for (const a of allAttachments) {
    const arr = attsByMessage.get(a.message_id) ?? [];
    arr.push(a);
    attsByMessage.set(a.message_id, arr);
  }
  const openaiMessages = await historyToOpenaiMessages(
    history,
    attsByMessage,
    caps,
    db,
  );

  // 5. Reserve an assistant row; we stream into it.
  const assistantMessageId = await db.insertMessage({
    conversationId,
    role: "assistant",
    content: "",
    status: "streaming",
    parentMessageId: userMessageId,
    senderKind: "agent",
    senderId: env.AGENT_UID,
  });
  if (!assistantMessageId) {
    throw new HttpError(500, "failed to reserve assistant message");
  }

  const abortController = cancels.register(assistantMessageId);
  // Map client disconnect to the same abort signal so we don't keep
  // burning provider tokens after the browser goes away.
  req.on("close", () => abortController.abort());

  // Session key pins openclaw's per-session state across turns. A2A
  // and webchat use different prefixes so an agent calling us doesn't
  // share workspace state with human users on the same conversation.
  const sessionKey = isAgentCaller
    ? `a2a:${conversationId}`
    : `webchat:${conversationId}`;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const sseSend = (payload: unknown): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  sseSend({
    type: "start",
    user_message_id: userMessageId,
    assistant_message_id: assistantMessageId,
  });

  let buffer = "";
  let finalStatus: "complete" | "interrupted" | "error" = "complete";
  // Filled in from the upstream `usage` frame when openclaw reports it
  // (requested via stream_options below). Persisted onto the assistant row
  // so the console's metrics dashboard can chart token in/out over time.
  const usageRef: { value: OpenaiUsage | null } = { value: null };
  try {
    const gatewayUrl = `http://127.0.0.1:${env.OPENCLAW_GATEWAY_PORT}/v1/chat/completions`;
    const payload = {
      model: process.env.OPENCLAW_MODEL_ROUTE ?? "openclaw/default",
      stream: true,
      // Ask the OpenAI-compatible endpoint to emit a final usage frame.
      stream_options: { include_usage: true },
      messages: openaiMessages,
    };
    const upstream = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENCLAW_GATEWAY_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "x-openclaw-session-key": sessionKey,
      },
      body: JSON.stringify(payload),
      signal: abortController.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const errBody = await upstream.text().catch(() => "");
      finalStatus = "error";
      sseSend({
        type: "error",
        error: `gateway ${upstream.status}: ${errBody.slice(0, 500)}`,
      });
      return;
    }

    for await (const token of iterOpenaiDeltas(upstream.body, usageRef)) {
      if (abortController.signal.aborted) {
        finalStatus = "interrupted";
        sseSend({
          type: "done",
          status: "interrupted",
          message_id: assistantMessageId,
        });
        return;
      }
      buffer += token;
      sseSend({ type: "token", delta: token });
    }

    sseSend({
      type: "done",
      status: "complete",
      message_id: assistantMessageId,
    });
  } catch (err) {
    if (abortController.signal.aborted) {
      finalStatus = "interrupted";
      sseSend({
        type: "done",
        status: "interrupted",
        message_id: assistantMessageId,
      });
    } else {
      log.error("streaming failed", { err: String(err) });
      finalStatus = "error";
      try {
        sseSend({ type: "error", error: "internal error" });
      } catch {
        /* response may already be torn down */
      }
    }
  } finally {
    await db.updateMessage(assistantMessageId, {
      content: buffer,
      status: finalStatus,
      completedAt: new Date().toISOString(),
      tokenUsage: buildTokenUsage(usageRef.value, env),
    });
    cancels.release(assistantMessageId);
    try {
      res.end();
    } catch {
      /* already closed */
    }
  }
}

// ── helpers ─────────────────────────────────────────────

async function authorizeConversation(
  conversationId: string,
  principal: Principal,
  db: MessagingDB,
  env: AgentEnv,
): Promise<NonNullable<Awaited<ReturnType<MessagingDB["getConversation"]>>>> {
  const conversation = await db.getConversation(conversationId);
  if (!conversation) throw new HttpError(404, "conversation not found");
  if (conversation.org_id !== env.AGENT_ORG) {
    throw new HttpError(404, "wrong org");
  }
  if (conversation.agent_uid !== env.AGENT_UID) {
    throw new HttpError(404, "wrong agent");
  }
  if (principal.kind === "agent") {
    if (principal.orgId !== env.AGENT_ORG) {
      throw new HttpError(403, "cross-org call forbidden");
    }
    const allowed = await db.agentConnectionExists(
      principal.agentUid,
      env.AGENT_UID,
    );
    if (!allowed) {
      throw new HttpError(403, "no agent_connection approved");
    }
  } else {
    const member = await db.userInOrg(principal.userId, env.AGENT_ORG);
    if (!member) throw new HttpError(403, "forbidden");
  }
  return conversation;
}

function validateAttachmentPath(
  path: string,
  orgId: string,
  conversationId: string,
): boolean {
  const prefix = `orgs/${orgId}/conversations/${conversationId}/`;
  if (!path.startsWith(prefix)) return false;
  if (path.includes("..")) return false;
  if ((path.match(/\//g) ?? []).length > 10) return false;
  return true;
}

async function persistAttachments(
  db: MessagingDB,
  messageId: string,
  conversationId: string,
  orgId: string,
  raw: AttachmentInput[],
): Promise<AttachmentRow[]> {
  const rows: InsertAttachmentRow[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const storagePath = entry.storage_path;
    const mimeType = entry.mime_type;
    const sizeBytes = entry.size_bytes;
    if (typeof storagePath !== "string" || typeof mimeType !== "string") continue;
    if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes)) continue;
    if (!validateAttachmentPath(storagePath, orgId, conversationId)) {
      log.warn("rejecting attachment with out-of-scope path", {
        storage_path: storagePath,
      });
      continue;
    }
    const row: InsertAttachmentRow = {
      message_id: messageId,
      conversation_id: conversationId,
      storage_path: storagePath,
      mime_type: mimeType,
      size_bytes: Math.trunc(sizeBytes),
    };
    if (typeof entry.original_name === "string") {
      row.original_name = entry.original_name;
    }
    if (typeof entry.width === "number" && Number.isFinite(entry.width)) {
      row.width = Math.trunc(entry.width);
    }
    if (typeof entry.height === "number" && Number.isFinite(entry.height)) {
      row.height = Math.trunc(entry.height);
    }
    rows.push(row);
  }
  return rows.length === 0 ? [] : await db.insertAttachments(rows);
}

/** Skip any single image larger than this (raw bytes) — a multi-MB inline
 *  data URL bloats the request and is rarely what the user wants read. */
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
/** Stop inlining once the per-turn budget across all images is exhausted, so
 *  a conversation with many images can't blow up the upstream payload. */
const MAX_TOTAL_INLINE_BYTES = 20 * 1024 * 1024;

/** One part of an OpenAI multimodal `content` array. */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * Build OpenAI-format messages from conversation history, inlining image
 * attachments as base64 data URLs for multimodal models.
 *
 * Ports the image-inlining path from the Python agent: for each row that
 * carries image attachments (and a multimodal model), download the bytes
 * from the `chat-attachments` bucket and emit an OpenAI multimodal content
 * array (`[{type:"text"}, {type:"image_url"}, …]`). Rows without inlineable
 * images keep the plain-string content shape. Non-image files and images on
 * text-only models are left out here — the caller already surfaced a
 * `fallbackNote` warning for those.
 */
async function historyToOpenaiMessages(
  rows: MessageRow[],
  attachmentsByMessage: Map<string, AttachmentRow[]>,
  caps: ModelCapabilities,
  db: MessagingDB,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let inlinedBytes = 0;
  for (const r of rows) {
    if (r.system_generated) continue;
    if (r.role !== "user" && r.role !== "assistant" && r.role !== "system" && r.role !== "tool") {
      continue;
    }
    const text = (r.content ?? "").trim();
    const msgAttachments = attachmentsByMessage.get(r.id) ?? [];
    const imageAtts = caps.multimodal
      ? msgAttachments.filter((a) => a.mime_type.startsWith("image/"))
      : [];

    if (imageAtts.length === 0) {
      if (!text) continue;
      out.push({ role: r.role, content: text });
      continue;
    }

    // Multimodal: download each image and inline it as a data URL.
    const parts: ContentPart[] = [];
    if (text) parts.push({ type: "text", text });
    for (const att of imageAtts) {
      if (att.size_bytes > MAX_INLINE_IMAGE_BYTES) {
        log.warn("skipping oversized inline image", {
          storage_path: att.storage_path,
          size_bytes: att.size_bytes,
        });
        continue;
      }
      if (inlinedBytes + att.size_bytes > MAX_TOTAL_INLINE_BYTES) {
        log.warn("inline image budget exhausted; skipping remaining images");
        break;
      }
      const base64 = await db.downloadAttachmentBase64(att.storage_path);
      if (!base64) continue;
      inlinedBytes += att.size_bytes;
      parts.push({
        type: "image_url",
        image_url: { url: `data:${att.mime_type};base64,${base64}` },
      });
    }

    // If every image was skipped/failed, fall back to plain text (or drop
    // the row if it had no text either).
    const hasImage = parts.some((p) => p.type === "image_url");
    if (!hasImage) {
      if (!text) continue;
      out.push({ role: r.role, content: text });
      continue;
    }
    out.push({ role: r.role, content: parts });
  }
  return out;
}

function fallbackNote(
  attachments: AttachmentRow[],
  caps: ModelCapabilities,
  provider: string,
  model: string,
): string | null {
  if (attachments.length === 0) return null;
  const images = attachments.filter((a) => a.mime_type.startsWith("image/"));
  const nonImages = attachments.filter((a) => !a.mime_type.startsWith("image/"));
  const complaints: string[] = [];
  if (images.length > 0 && !caps.multimodal) {
    complaints.push(`${images.length} image${images.length !== 1 ? "s" : ""}`);
  }
  if (nonImages.length > 0 && !caps.fileInput) {
    complaints.push(`${nonImages.length} file${nonImages.length !== 1 ? "s" : ""}`);
  }
  if (complaints.length === 0) return null;
  const modelLabel =
    provider && model ? `\`${provider}/${model}\`` : "this agent's model";
  const joined = complaints.join(" and ");
  const verb = complaints.length === 1 && images.length === 1 ? "was" : "were";
  return (
    `⚠️ ${modelLabel} doesn't support image or file inputs. ` +
    `Your ${joined} ${verb} saved to the conversation but weren't read by the agent. ` +
    "Switch to a multimodal model in agent settings to have the agent act on them."
  );
}

/** OpenAI-compatible usage block, as emitted on the final stream frame. */
interface OpenaiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  model?: string;
}

/**
 * Normalize the upstream usage frame into the `messages.token_usage` JSONB
 * shape the console's metrics dashboard reads
 * (`input_tokens` / `output_tokens` / `total_tokens`). Returns undefined when
 * the gateway reported no usage so we don't overwrite the column with zeros.
 */
function buildTokenUsage(
  usage: OpenaiUsage | null,
  env: AgentEnv,
): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  if (typeof input !== "number" && typeof output !== "number") return undefined;
  const inputTokens = typeof input === "number" ? input : 0;
  const outputTokens = typeof output === "number" ? output : 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens:
      typeof usage.total_tokens === "number"
        ? usage.total_tokens
        : inputTokens + outputTokens,
    provider: env.LLM_PROVIDER,
    model: usage.model ?? env.LLM_MODEL,
  };
}

/**
 * Yields content deltas from an OpenAI-compatible SSE stream.
 * Mirrors _iter_upstream_deltas in the Python version, minus the
 * tool-call branch (openclaw handles the agentic loop internally and
 * doesn't emit `delta.tool_calls` frames on this endpoint today).
 *
 * Captures the trailing `usage` frame (requested via stream_options) into
 * `usageRef` as a side channel so the caller can persist token counts.
 */
async function* iterOpenaiDeltas(
  body: ReadableStream<Uint8Array>,
  usageRef?: { value: OpenaiUsage | null },
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!line || !line.startsWith("data:")) continue;
        const body = line.slice("data:".length).trim();
        if (body === "[DONE]") return;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(body);
        } catch {
          continue;
        }
        // Usage frames arrive on their own chunk (often with empty choices)
        // when stream_options.include_usage is set. Capture the latest.
        if (usageRef && frame.usage && typeof frame.usage === "object") {
          const u = frame.usage as OpenaiUsage;
          usageRef.value = {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.total_tokens,
            model: typeof frame.model === "string" ? frame.model : u.model,
          };
        }
        const choices = (frame.choices as Array<Record<string, unknown>>) ?? [];
        const choice = choices[0] ?? {};
        const delta = (choice.delta as Record<string, unknown>) ?? {};
        const text = delta.content;
        if (typeof text === "string" && text) {
          yield text;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
