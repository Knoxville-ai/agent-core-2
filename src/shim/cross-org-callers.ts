import type { Conversation } from "./supabase-db.js";

/**
 * Whether an agent principal from ANOTHER org may reach this conversation.
 *
 * Agent-to-agent authorization is enforced console-side: the console opens a
 * conversation only for a caller one of its bindings allows, and mints that
 * caller's A2A token with the caller's real org. Across the org boundary, this
 * agent admits only conversations the console stamped with the binding that
 * allowed them:
 *   - drive_through_connection_id: a curated cross-org drive-thru (console
 *     migration 0046);
 *   - delegation_connection_id: a delegation connection, which crosses orgs
 *     only when the caller is in the platform's own org (console
 *     docs/personal-assistants-design.md §4d).
 * Anything else from another org is refused. Credential sharing on such a turn
 * is still limited to the operator-selected set, pulled and audited through
 * get_delegated_credentials.
 */
export function crossOrgAgentAllowed(
  conversation: Pick<Conversation, "drive_through_connection_id" | "delegation_connection_id">,
): boolean {
  return Boolean(conversation.drive_through_connection_id || conversation.delegation_connection_id);
}
