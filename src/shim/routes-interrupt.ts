import type { IncomingMessage, ServerResponse } from "node:http";

import type { AgentEnv } from "../env.js";
import { HttpError, type Principal } from "./auth.js";
import type { CancelRegistry } from "./cancel-registry.js";
import type { MessagingDB } from "./supabase-db.js";
import { readJsonBody, sendJson } from "./util.js";

/**
 * POST /api/v1/conversations/:id/interrupt
 *
 * Body: { assistant_message_id: string }
 *
 * Flips the cancel flag on an in-flight assistant stream. Idempotent:
 * if the stream has already completed or never existed, returns 200
 * with { cancelled: false }. Mirrors the Python interrupt handler.
 */
export async function handleInterrupt(
  conversationId: string,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  deps: { env: AgentEnv; db: MessagingDB; cancels: CancelRegistry },
): Promise<void> {
  const { env, db, cancels } = deps;

  // Authorize the conversation first so an unrelated caller can't probe
  // assistant_message_ids on someone else's agent.
  const conversation = await db.getConversation(conversationId);
  if (!conversation) throw new HttpError(404, "conversation not found");
  if (conversation.org_id !== env.AGENT_ORG) {
    throw new HttpError(404, "wrong org");
  }
  if (conversation.agent_uid !== env.AGENT_UID) {
    throw new HttpError(404, "wrong agent");
  }
  if (principal.kind === "agent") {
    // A2A authorization is enforced console-side in the MCP call path (see
    // routes-messages.ts authorizeConversation). Same-org is all we assert here.
    if (principal.orgId !== env.AGENT_ORG) {
      throw new HttpError(403, "cross-org call forbidden");
    }
  } else if (conversation.user_id !== null) {
    // Anonymous conversations (public drive-thru + agent-to-agent) are
    // addressable by any console-minted token; only user-owned conversations
    // require org membership. See routes-messages.ts authorizeConversation.
    const member = await db.userInOrg(principal.userId, env.AGENT_ORG);
    if (!member) throw new HttpError(403, "forbidden");
  }

  const body =
    (await readJsonBody<{ assistant_message_id?: unknown }>(req)) ?? {};
  const messageId =
    typeof body.assistant_message_id === "string"
      ? body.assistant_message_id.trim()
      : "";
  if (!messageId) {
    throw new HttpError(400, "assistant_message_id required");
  }
  const cancelled = cancels.signal(messageId);
  sendJson(res, 200, { cancelled });
}
