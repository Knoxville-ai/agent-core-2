import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { LLM_COMPLETE_PATH, createCompleteHandler } from "./complete.js";

/**
 * Knox LLM complete — a one-shot completion on the agent's own model, for the
 * shim's side tasks.
 *
 * Why this exists
 * ---------------
 * The shim only reaches the model through openclaw's `/v1/chat/completions`,
 * which runs a full agent turn: the agent's whole system prompt (SOUL.md alone
 * is ~40–50k chars), every tool schema, a session transcript. That is the right
 * shape for a reply and absurd for a side task like naming a conversation. Going
 * around openclaw to the provider instead would mean re-implementing its model,
 * auth and base-URL resolution — and it cannot work at all for an agent on
 * Codex OAuth, whose token only openclaw can read.
 *
 * openclaw already has the right primitive: `api.runtime.llm.complete`, a
 * host-owned single completion that resolves the agent's default model,
 * credentials (OAuth included) and base URL (so OpenRouter traffic still flows
 * through the cost proxy) with no prompt, tools or session of its own. This
 * plugin puts that primitive on a gateway HTTP route so the shim can call it.
 *
 * Boundaries:
 *   - Gateway-token auth, on a loopback-bound gateway: the same trust anchor as
 *     the chat-completions route the shim already calls, which can do strictly
 *     more than this one.
 *   - Always the agent's default model; the request cannot pick another.
 *   - Stateless: no session, no transcript, no tools. The text goes back to the
 *     caller and nowhere else.
 */
export default definePluginEntry({
  id: "knox-llm-complete",
  name: "Knox LLM Complete",
  description:
    "Expose a loopback, one-shot completion on the agent's own model (no agent prompt, no tools) for the shim's side tasks, such as naming a conversation.",
  register(api) {
    api.registerHttpRoute({
      path: LLM_COMPLETE_PATH,
      auth: "gateway",
      match: "exact",
      handler: createCompleteHandler(api),
    });
  },
});
