import type { GatewayClient } from "../openclaw/gateway-client.js";

/**
 * Maps the console's `conversation_id` (UUID) to an openclaw session key.
 *
 * The console treats a conversation as a long-lived thread; openclaw uses
 * sessions as the durable unit too. We use a 1:1 mapping and keep the
 * mapping in memory — the conversation_id is deterministic, so on restart
 * we just call `sessions.create` again with the same key and openclaw
 * resumes or recreates as appropriate.
 */
export class SessionRegistry {
  private readonly known = new Map<string, string>();

  constructor(private readonly gateway: GatewayClient) {}

  /**
   * Returns the openclaw session key for a conversation, creating the
   * session on first use.
   */
  async resolve(conversationId: string): Promise<string> {
    const cached = this.known.get(conversationId);
    if (cached) return cached;

    const key = `conv-${conversationId}`;
    // Create is idempotent in practice: if the session already exists,
    // openclaw returns the existing one. Tolerate either response shape.
    try {
      await this.gateway.request("sessions.create", { key });
    } catch (err) {
      // "already exists" is fine; surface other failures.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/exist|duplicate/i.test(msg)) {
        throw err;
      }
    }
    this.known.set(conversationId, key);
    return key;
  }
}
