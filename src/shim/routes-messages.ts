import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import type { MemoryCheckpoint } from "../provision/agent-memory.js";
import { HttpError, type Principal } from "./auth.js";
import { buildDynamicContext, parseAdvisoryCaller } from "./dynamic-context.js";
import type { CancelRegistry } from "./cancel-registry.js";
import { resolveCapabilities, type ModelCapabilities } from "./model-capabilities.js";
import type {
  AttachmentRow,
  InsertAttachmentRow,
  MessageRow,
  MessagingDB,
} from "./supabase-db.js";
import { BundleClient, type DelegatedCredentials } from "../bundle/client.js";
import {
  credentialKeyNames,
  DELEGATED_TURN_SYSTEM_NOTE,
  detectDelegatedTurn,
  type CredentialLease,
  type DelegatedCredentialStore,
} from "./delegated-credentials.js";
import { fetchOpenclawStream } from "./openclaw-gateway-fetch.js";
import {
  logUsageTotals,
  type CacheUsageTotals,
  type UsageAccumulator,
} from "./usage-telemetry.js";
import { readJsonBody } from "./util.js";
import {
  type Mcq,
  mcqToModelText,
  parseKnoxAsk,
  parseStoredMcq,
  SentinelFilter,
} from "./mcq.js";

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
 *     { type: "question", question }   // structured multiple-choice ask (mcq)
 *     { type: "done",  status: "complete"|"interrupted", message_id }
 *     { type: "error", error }
 *
 * Persists the user turn + reserves an assistant row before calling
 * openclaw's /v1/chat/completions endpoint, streams deltas into the
 * row, and updates the row's status + final content on done.
 */

/** How often to emit an SSE comment during a silent stretch of a turn. Well
 *  inside the ~60s idle window edge proxies enforce. */
const KEEPALIVE_INTERVAL_MS = 15_000;

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
  memory: MemoryCheckpoint;
  /** Per-turn delegated-credential store, keyed by openclaw session key. Written
   *  here on a delegated turn, read by the loopback route the gateway plugin
   *  calls, cleared when the turn ends. */
  delegatedCreds: DelegatedCredentialStore;
  /** Per-turn model-call / prompt-cache rollup, filled by the loopback usage
   *  ingest route and drained here when the assistant row finalizes. */
  usage: UsageAccumulator;
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

  // 3. Model capabilities + warning for dropped attachment types. Explicit
  // catalog overrides (LLM_MULTIMODAL / LLM_FILE_INPUT) win over the static
  // (provider, model) table so a runtime-added model still forwards media.
  const caps = resolveCapabilities(env.LLM_PROVIDER, env.LLM_MODEL, {
    multimodal: env.LLM_MULTIMODAL,
    fileInput: env.LLM_FILE_INPUT,
  });
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
  // openclaw's tools (bash/python inside skills) run against the rendered
  // workspace, so materialize image attachments there and hand the model the
  // on-disk paths. Without this, images only exist as inlined base64 in the
  // prompt — a deterministic compositing skill has no file to read.
  const workspaceDir = join(env.OPENCLAW_STATE_DIR, "workspace");
  const openaiMessages = await historyToOpenaiMessages(
    history,
    attsByMessage,
    caps,
    db,
    workspaceDir,
    conversationId,
  );

  // DYNAMIC layer: recompute per-turn caller context (who is calling + what we
  // have learned about them) and conversation-scoped recent memory. SOUL.md
  // carries the STATIC identity; anything per-caller/per-turn must be injected
  // here because SOUL is assembled once at boot. Fail-open — a missing table or a
  // DB hiccup must never break a turn.
  //
  // PLACEMENT (prompt-cache critical): this block is APPENDED, not prepended.
  //
  // Its content is recomputed every turn from mutating sources — recent memories,
  // caller context ordered by `last_interaction_at`, and a 30s-TTL knowledge
  // index. At index 0 a single `remember` call during turn N changes byte 0 of
  // turn N+1, which invalidates the ENTIRE prompt prefix: providers match the
  // cache token-by-token from the front, so one changed leading token forces a
  // full recompute of everything after it. Worse, `buildDynamicContext` returns
  // null when it has no sections, so a conversation could flip between "no
  // leading system message" and "one" mid-stream, shifting every message index.
  //
  // Appending moves the volatile bytes behind the entire stable history, so the
  // shared prefix across consecutive turns goes from ~0% to ~everything-but-the-
  // tail. The model still sees the same content in the same turn.
  //
  // Set AGENT_DYNAMIC_CONTEXT_POSITION=lead to restore the old prepend behavior
  // without a code release, if a model is found to weight a trailing system
  // block differently.
  try {
    const dynamic = await buildDynamicContext(
      db,
      env,
      principal,
      parseAdvisoryCaller(req.headers),
    );
    if (dynamic) {
      const msg = { role: "system" as const, content: dynamic };
      if (env.AGENT_DYNAMIC_CONTEXT_POSITION === "lead") {
        openaiMessages.unshift(msg);
      } else {
        openaiMessages.push(msg);
      }
    }
  } catch (err) {
    log.warn("dynamic context injection failed (non-fatal)", {
      err: String(err),
    });
  }

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

  // Open this turn's usage bucket. Every model call openclaw makes inside the
  // agentic loop reports back through the loopback ingest route under this same
  // session key; we drain the rollup in the `finally` below.
  deps.usage.begin(sessionKey);

  // Platform-brokered delegated credentials (agent-to-agent turns only).
  // On a delegated turn, pull the credentials the calling agent shared for THIS
  // conversation and stash them keyed by the session key. The openclaw
  // `before_tool_call` plugin reads them back over the loopback route and injects
  // them into this turn's skill subprocess env, so a skill reads them from its
  // environment exactly as it would standalone. They are NEVER added to
  // `openaiMessages` / the prompt / the transcript, and are cleared in the
  // `finally` below. A non-delegated turn skips this entirely, so its skills see
  // no delegated env — keyed isolation, no cross-turn leakage.
  const delegated = detectDelegatedTurn(req.headers, principal.kind, conversationId);
  // Lease for the entry THIS turn stages, so the `finally` below only clears
  // what it staged. Two turns can be live on one conversation (a caller that
  // re-sends after its MCP client times out is the common way), and clearing by
  // session key alone lets the first to finish wipe the second's credentials.
  let credentialLease: CredentialLease = 0;
  if (delegated.delegated) {
    const creds = await fetchDelegatedCredentialsForTurn(env, delegated.conversationId);
    credentialLease = deps.delegatedCreds.set(sessionKey, creds);
    if (Object.keys(creds).length > 0) {
      // Key names + count only — never the values.
      log.info("delegated credentials staged for turn", {
        session_key: sessionKey,
        connection_id: delegated.connectionId,
        keys: credentialKeyNames(creds),
      });
    }
    // Steer weaker models toward actually running the skill on this turn (the
    // brokered creds live in the skill's exec env, invisible to the model, so a
    // model that hunts for them concludes "no access" and bails). It carries NO
    // credential values — behavioral guidance only — and is added ONLY to the
    // outgoing message array here, never written back to the conversation
    // history.
    //
    // Appended for the same prompt-cache reason as the dynamic block above: this
    // note is present on delegated turns and absent on ordinary ones, so at
    // index 0 it made the identity of the first message alternate on any
    // conversation that mixes the two — zeroing the shared prefix every time it
    // flipped. At the tail it is also simply more recent, which is where a
    // behavioral nudge wants to be.
    openaiMessages.push({ role: "system", content: DELEGATED_TURN_SYSTEM_NOTE });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const sseSend = (payload: unknown): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // Keepalive. A turn that spends minutes inside one tool call emits no token
  // deltas, and an idle HTTP connection is exactly what an edge proxy reaps
  // (Railway's is ~60s) — which surfaced as "the agent just stopped replying"
  // on precisely the slow turns that mattered. An SSE comment line is ignored
  // by every conformant client (the console's reader skips non-`data:` lines,
  // and the A2A bridge's parser does too) but it keeps bytes moving.
  //
  // Note this only buys a turn more time; it is NOT how long work should be
  // done. Anything that runs for many minutes belongs in a task (routes-tasks),
  // which holds no connection at all.
  const keepalive = setInterval(() => {
    try {
      res.write(`: keepalive ${Date.now()}\n\n`);
    } catch {
      /* stream already torn down; the finally below clears the timer */
    }
  }, KEEPALIVE_INTERVAL_MS);
  keepalive.unref?.();

  sseSend({
    type: "start",
    user_message_id: userMessageId,
    assistant_message_id: assistantMessageId,
  });

  let buffer = "";
  // Set when the model emitted a structured multiple-choice question this turn.
  // When present, the assistant row is persisted as the serialized `mcq` payload
  // (not the raw fenced text), matching the console's structured-message convention.
  let questionPayload: Mcq | null = null;
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
    const upstream = await fetchOpenclawStream(gatewayUrl, {
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

    // The sentinel filter hides an in-progress ```knox:ask block from the visible
    // token stream, so the raw JSON never flashes in the chat while the model is
    // writing it. We still accumulate the full text into `buffer` for parsing.
    const sentinel = new SentinelFilter();
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
      const visible = sentinel.push(token);
      if (visible) sseSend({ type: "token", delta: visible });
    }
    const tail = sentinel.flush();
    if (tail) sseSend({ type: "token", delta: tail });

    // If the model asked a structured multiple-choice question, turn the
    // suppressed knox:ask block into a `question` frame and persist the assistant
    // row as the `mcq` payload. This frame is consumed identically by a human's
    // browser (renders the widget) and by the platform A2A bridge (hands the
    // options back to the calling agent). Falls back to plain text if the block
    // can't be parsed, so a malformed ask never swallows the reply.
    if (sentinel.sawSentinel) {
      const mcq = parseKnoxAsk(buffer);
      if (mcq) {
        questionPayload = mcq;
        sseSend({ type: "question", question: mcq });
      } else {
        sseSend({ type: "token", delta: sentinel.suppressedText() });
      }
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
    clearInterval(keepalive);
    // Drop the delegated credentials THIS turn staged. The turn is over, so they
    // must not outlive it — but passing the lease means we do not wipe an entry a
    // later, still-running turn staged under the same session key. Idempotent +
    // safe on a non-delegated turn (lease 0 matches nothing).
    deps.delegatedCreds.clear(sessionKey, credentialLease);
    // Drain this turn's per-model-call rollup (prompt-cache split + loop
    // iteration count). Null when the telemetry plugin is not loaded, in which
    // case token_usage keeps exactly its previous shape.
    const cacheTotals = deps.usage.drain(sessionKey);
    if (cacheTotals) logUsageTotals(sessionKey, cacheTotals);
    await db.updateMessage(assistantMessageId, {
      content: questionPayload ? JSON.stringify(questionPayload) : buffer,
      status: finalStatus,
      completedAt: new Date().toISOString(),
      tokenUsage: buildTokenUsage(usageRef.value, env, cacheTotals),
    });
    cancels.release(assistantMessageId);
    try {
      res.end();
    } catch {
      /* already closed */
    }
    // Checkpoint agent-owned memory (playbook.md + notes/) to Supabase now that
    // the turn is complete and any tool-driven file writes have settled. The
    // turn boundary is a race-free quiet point; checkpoint() is coalesced and
    // never throws (M1 volume still holds the bytes if an upload fails).
    await deps.memory.checkpoint();
  }
}

// ── helpers ─────────────────────────────────────────────

/**
 * Build a one-shot platform MCP client from env and fetch the delegated
 * credentials for this conversation. Reuses the same URL + knox_agent token as
 * the boot `get_my_bundle` call. Returns `{}` when the platform MCP isn't
 * configured (agent has no outbound A2A) or on any error — never throws into the
 * turn, so a broker hiccup degrades to "no delegated creds" rather than a failed
 * reply.
 */
export async function fetchDelegatedCredentialsForTurn(
  env: AgentEnv,
  conversationId: string,
): Promise<DelegatedCredentials> {
  if (!env.PLATFORM_MCP_URL || !env.PLATFORM_API_TOKEN) return {};
  const client = new BundleClient({
    url: env.PLATFORM_MCP_URL,
    token: env.PLATFORM_API_TOKEN,
    timeoutMs: 5000,
  });
  return client.fetchDelegatedCredentials(conversationId);
}

export async function authorizeConversation(
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
    // Agent-to-agent authorization (the outbound delegation allowlist) is
    // enforced console-side in the MCP call path — start_agent_conversation /
    // start_conversation reject a caller that isn't bound to this agent/listing
    // before a conversation is ever opened.
    //
    // Same-org A2A stays strict: an agent principal must be in this agent's org.
    // The ONE exception is a curated cross-org drive-thru call — the console
    // stamps drive_through_connection_id when an operator-bound caller opens the
    // conversation, and mints an honest A2A token carrying the caller's real
    // org. Permit those, and only those, across the org boundary (console
    // migration 0046). Credential sharing on such a turn is still limited to the
    // operator-selected set and pulled + audited via get_delegated_credentials.
    if (
      principal.orgId !== env.AGENT_ORG &&
      !conversation.drive_through_connection_id
    ) {
      throw new HttpError(403, "cross-org call forbidden");
    }
  } else if (conversation.user_id !== null) {
    // A non-agent token that verified against SUPABASE_JWT_SECRET can only have
    // been minted by the console, which authorizes the caller before it opens
    // the conversation. Anonymous conversations (user_id null — public
    // drive-thru chats and agent-to-agent delegation, where the conversation_id
    // is the capability) are addressable by anyone the console let through.
    // Only user-owned conversations require the caller to be an org member.
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
/** Cap for writing an image to the workspace filesystem. Higher than the
 *  inline caps: a skill can composite a high-res source we'd never inline
 *  into the prompt, so being on disk is worth more headroom. */
const MAX_DISK_IMAGE_BYTES = 64 * 1024 * 1024;

/** One part of an OpenAI multimodal `content` array. */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * Build OpenAI-format messages from conversation history.
 *
 * Two independent things happen to image attachments:
 *
 *   1. **Materialize to disk** — every image is written to
 *      `workspace/attachments/<conversationId>/` (idempotently) so openclaw's
 *      tools and skills can read it by path. The on-disk paths are then
 *      described to the model in a text part so it can hand them to a
 *      deterministic compositing skill (e.g. drivethru-graphic-artist)
 *      instead of asking the user to re-upload. This happens regardless of
 *      whether the model is multimodal — a compositor doesn't need vision.
 *
 *   2. **Inline as base64** — for multimodal models each image is also
 *      emitted as an `image_url` data URL so the model can *see* it, subject
 *      to the per-image and per-turn byte budgets.
 *
 * Rows with no image attachments keep the plain-string content shape.
 * Non-image files are left out here — the caller already surfaced a
 * `fallbackNote` warning for those.
 */
export async function historyToOpenaiMessages(
  rows: MessageRow[],
  attachmentsByMessage: Map<string, AttachmentRow[]>,
  caps: ModelCapabilities,
  db: MessagingDB,
  workspaceDir: string,
  conversationId: string,
): Promise<Array<Record<string, unknown>>> {
  const attachDir = join(
    workspaceDir,
    "attachments",
    conversationId.replace(/[^A-Za-z0-9._-]/g, "_"),
  );
  const out: Array<Record<string, unknown>> = [];
  let inlinedBytes = 0;
  for (const r of rows) {
    if (r.system_generated) continue;
    if (r.role !== "user" && r.role !== "assistant" && r.role !== "system" && r.role !== "tool") {
      continue;
    }
    let text = (r.content ?? "").trim();
    // A prior structured question is stored as serialized `mcq` JSON. Render it
    // back to a concise textual summary so the model reads a clean question →
    // answer exchange rather than raw JSON on the next turn.
    if (r.role === "assistant" && text) {
      const storedMcq = parseStoredMcq(text);
      if (storedMcq) text = mcqToModelText(storedMcq);
    }
    const msgAttachments = attachmentsByMessage.get(r.id) ?? [];
    const imageAtts = msgAttachments.filter((a) =>
      a.mime_type.startsWith("image/"),
    );

    if (imageAtts.length === 0) {
      if (!text) continue;
      out.push({ role: r.role, content: text });
      continue;
    }

    const savedPaths: Array<{ att: AttachmentRow; localPath: string }> = [];
    const imageParts: ContentPart[] = [];
    for (const att of imageAtts) {
      // 1. Ensure the image is on disk for skills to read by path.
      const materialized = await materializeImage(att, attachDir, db);
      if (materialized) {
        savedPaths.push({ att, localPath: materialized.localPath });
      }

      // 2. Additionally inline it for multimodal models to see.
      if (!caps.multimodal) continue;
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
      const base64 =
        materialized?.base64 ??
        (await db.downloadAttachmentBase64(att.storage_path));
      if (!base64) continue;
      inlinedBytes += att.size_bytes;
      imageParts.push({
        type: "image_url",
        image_url: { url: `data:${att.mime_type};base64,${base64}` },
      });
    }

    // No image was inlined (text-only model, or all inline attempts skipped).
    // Fold any on-disk path note into the plain-string content so the model
    // can still act on the files, and drop the row only if nothing is left.
    if (imageParts.length === 0) {
      const note = savedPaths.length ? buildAttachmentPathNote(savedPaths) : "";
      const merged = [text, note].filter(Boolean).join("\n\n");
      if (!merged) continue;
      out.push({ role: r.role, content: merged });
      continue;
    }

    // At least one inlined image → multimodal content array.
    const parts: ContentPart[] = [];
    if (text) parts.push({ type: "text", text });
    if (savedPaths.length) {
      parts.push({ type: "text", text: buildAttachmentPathNote(savedPaths) });
    }
    parts.push(...imageParts);
    out.push({ role: r.role, content: parts });
  }
  return out;
}

/**
 * Write an image attachment into the workspace so openclaw tools/skills can
 * read it by path. Idempotent: if a file of the expected size is already
 * there (e.g. materialized on a previous turn), we skip the re-download.
 *
 * Returns the absolute local path plus the base64 bytes when we had to
 * download them (so the caller can reuse them for inlining without a second
 * fetch), or null if the image was too large or the download/write failed.
 */
async function materializeImage(
  att: AttachmentRow,
  dir: string,
  db: MessagingDB,
): Promise<{ localPath: string; base64: string | null } | null> {
  const localPath = join(dir, attachmentFileName(att));

  if (await fileHasSize(localPath, att.size_bytes)) {
    return { localPath, base64: null };
  }
  if (att.size_bytes > MAX_DISK_IMAGE_BYTES) {
    log.warn("skipping on-disk materialization of oversized image", {
      storage_path: att.storage_path,
      size_bytes: att.size_bytes,
    });
    return null;
  }

  const base64 = await db.downloadAttachmentBase64(att.storage_path);
  if (!base64) return null;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(localPath, Buffer.from(base64, "base64"));
  } catch (err) {
    log.warn("failed to write attachment to workspace", {
      local_path: localPath,
      err: String(err),
    });
    return null;
  }
  return { localPath, base64 };
}

/** A collision-free, path-safe filename for an attachment on disk. The row id
 *  (a UUID) guarantees uniqueness; the sanitized original name keeps it
 *  recognizable and preserves an extension the compositor can sniff. */
function attachmentFileName(att: AttachmentRow): string {
  const base = att.original_name ? basename(att.original_name) : "image";
  let safe = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  if (!extname(safe)) safe += extForMime(att.mime_type);
  return `${att.id}__${safe}`;
}

/** Map an image mime type to a file extension for names that lack one. */
function extForMime(mime: string): string {
  const sub = (mime.split("/")[1] ?? "").toLowerCase();
  if (!sub) return "";
  if (sub === "jpeg") return ".jpg";
  if (sub === "svg+xml") return ".svg";
  return "." + sub.replace(/[^a-z0-9]/g, "");
}

/** True if `path` exists, is a regular file, and matches the expected size —
 *  our idempotency check for "already materialized this attachment". */
async function fileHasSize(path: string, size: number): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile() && s.size === size;
  } catch {
    return false;
  }
}

/** A text block, addressed to the model, listing where each image was saved
 *  on disk so it can pass real paths to compositing/graphic skills. */
function buildAttachmentPathNote(
  saved: Array<{ att: AttachmentRow; localPath: string }>,
): string {
  const lines = saved.map(({ att, localPath }) => {
    const name = att.original_name ?? basename(localPath);
    return `  - ${name} → ${localPath}`;
  });
  return (
    "The image attachment(s) on this message are saved on the local filesystem " +
    "so tools and skills can read them directly (no re-upload needed):\n" +
    lines.join("\n") +
    "\nWhen a skill needs image file paths (e.g. the drivethru-graphic-artist " +
    "compositor), pass these paths."
  );
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
export interface OpenaiUsage {
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
 *
 * `cache` carries the per-turn rollup from the knox-usage-telemetry plugin
 * (see usage-telemetry.ts). When present we add the prompt-cache breakdown and
 * the model-call count.
 *
 * IMPORTANT for cost math: `input_tokens` stays INCLUSIVE of cache reads,
 * because that is what openclaw's OpenAI-compat endpoint reports
 * (`prompt_tokens = input + cacheRead`) and changing its meaning would silently
 * rewrite every historical comparison. The added fields decompose it:
 *
 *     input_tokens = uncached_input_tokens + cache_read_input_tokens
 *
 * so a consumer prices a turn as
 *
 *     uncached_input_tokens * input_usd_per_mtok
 *   + cache_read_input_tokens * cached_input_usd_per_mtok
 *   + output_tokens * output_usd_per_mtok
 *
 * Cache-write tokens are reported separately and are NOT part of `input_tokens`
 * (the compat endpoint excludes them), so they must be priced on their own.
 */
export function buildTokenUsage(
  usage: OpenaiUsage | null,
  env: AgentEnv,
  cache?: CacheUsageTotals | null,
): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  if (typeof input !== "number" && typeof output !== "number") return undefined;
  const inputTokens = typeof input === "number" ? input : 0;
  const outputTokens = typeof output === "number" ? output : 0;
  const base: Record<string, unknown> = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens:
      typeof usage.total_tokens === "number"
        ? usage.total_tokens
        : inputTokens + outputTokens,
    provider: env.LLM_PROVIDER,
    model: usage.model ?? env.LLM_MODEL,
  };
  if (!cache) return base;

  // Prefer the compat endpoint's `prompt_tokens` as the authoritative total and
  // derive the uncached remainder from the measured cache reads, so the identity
  // above holds even if the two sources disagree by a few tokens (retries inside
  // the loop can make the plugin's sum drift from the final frame).
  const cacheRead = Math.min(cache.cacheRead, inputTokens);
  return {
    ...base,
    uncached_input_tokens: Math.max(0, inputTokens - cacheRead),
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cache.cacheWrite,
    model_calls: cache.modelCalls,
    ...(cache.resolvedRef ? { resolved_ref: cache.resolvedRef } : {}),
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
export interface StreamTermination {
  /** The last `choice.finish_reason` the stream reported, or null if none. */
  finishReason: string | null;
  /** True once the `[DONE]` sentinel arrived — a clean OpenAI-style stream end. */
  sawDone: boolean;
}

export async function* iterOpenaiDeltas(
  body: ReadableStream<Uint8Array>,
  usageRef?: { value: OpenaiUsage | null },
  // Side channel (like usageRef) for the stream's terminal state. Lets the task
  // executor tell a clean completion from a run openclaw aborted mid-tool-use
  // (finish_reason "tool_calls") or a cut stream (no [DONE]) — see task-runner.
  terminalRef?: { value: StreamTermination },
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
        if (body === "[DONE]") {
          if (terminalRef) terminalRef.value.sawDone = true;
          return;
        }
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
        const finishReason = choice.finish_reason;
        if (terminalRef && typeof finishReason === "string" && finishReason) {
          terminalRef.value.finishReason = finishReason;
        }
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
