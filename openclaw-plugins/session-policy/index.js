import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

import {
  getShim,
  hookResult,
  isPlatformTool,
  isVoiceSessionKey,
  postShim,
  stampSession,
  VERIFY_CALLER_TOOL,
} from "./policy.js";

/**
 * Knox session policy — the OpenClaw half of the agent's per-session tool
 * rules (src/shim/session-policy.ts) and of "requires approval" on connector
 * tools the agent reaches directly (src/shim/tool-approvals.ts).
 *
 *   before_tool_call   runs first (highest priority) on every tool call and
 *                      asks the shim whether this session may make it. The
 *                      shim's refusal is returned as a block with its reason.
 *                      Fail-closed: no answer from the shim, no call. A
 *                      platform tool call that may run is stamped with its
 *                      session, for the shim's console MCP route to turn into
 *                      the console's session headers.
 *   before_prompt_build  adds the boot memory digest to the system prompt of
 *                      sessions the shim says are trusted (an untrusted
 *                      session never gets it).
 *   verify_caller_pin  offered on phone calls only: checks the caller's phone
 *                      PIN, which opens the owner's tools for the rest of the
 *                      call.
 */
export default definePluginEntry({
  id: "knox-session-policy",
  name: "Knox Session Policy",
  description:
    "Check every tool call against the agent's session policy and approval gate, stamp platform tool calls with their session, and offer phone callers PIN verification.",
  register(api) {
    const stampSessions = api.pluginConfig?.stampSessions === true;

    api.on(
      "before_tool_call",
      async (event, ctx) => {
        const toolName = event?.toolName;
        const sessionKey = ctx?.sessionKey ?? event?.sessionKey ?? null;
        const answer = await postShim("/internal/tool-policy", {
          session_key: sessionKey,
          tool_name: typeof toolName === "string" ? toolName : "",
          params: event?.params ?? {},
        });
        const blocked = hookResult(answer);
        if (blocked) {
          console.error(`[knox-session-policy] refused ${String(toolName)} (session=${sessionKey ?? "none"})`);
          return blocked;
        }
        if (stampSessions && isPlatformTool(toolName)) stampSession(event?.params, sessionKey);
        return undefined;
      },
      { priority: 100 },
    );

    api.on("before_prompt_build", async (_event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      if (!sessionKey) return undefined;
      const info = await getShim(`/internal/session-context?session_key=${encodeURIComponent(sessionKey)}`);
      const digest = typeof info?.memory_digest === "string" ? info.memory_digest.trim() : "";
      if (!digest) return undefined;
      return { appendSystemContext: `---\n\n# MEMORY\n\n${digest}` };
    });

    api.registerTool(
      (ctx) => {
        const sessionKey = ctx?.sessionKey;
        if (!isVoiceSessionKey(sessionKey)) return null;
        return {
          name: VERIFY_CALLER_TOOL,
          label: "Verify caller",
          description:
            "Check the phone PIN the caller just said. Until it is confirmed you can answer questions and help with " +
            "what the call is already waiting on, but not act for them. Pass exactly the digits they said.",
          parameters: Type.Object({ pin: Type.String({ description: "The digits the caller said, e.g. 4421." }) }),
          async execute(_toolCallId, params) {
            const answer = await postShim("/internal/voice-step-up", { session_key: sessionKey, pin: params?.pin });
            const text =
              typeof answer?.text === "string" ? answer.text : "The PIN couldn't be checked right now. Try again shortly.";
            return { content: [{ type: "text", text }], details: { verified: answer?.ok === true } };
          },
        };
      },
      { name: VERIFY_CALLER_TOOL },
    );
  },
});
