import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { buildVoiceContext, isVoiceSessionKey } from "./context.js";

/**
 * Knox voice context — tells the agent, on every consult the realtime voice
 * makes during a phone call, who is on the line (from the shim's call mirror,
 * which knows the console's "Accept calls from" members and profile phones)
 * and how to hand long work off. The voice-call plugin's own consult prompt
 * carries neither the caller's identity nor any of this.
 *
 * Fail-open: no answer from the shim → a generic "live phone call" context.
 * Wired only on vessels with a phone (src/provision/render-workspace.ts).
 */
export default definePluginEntry({
  id: "knox-voice-context",
  name: "Knox Voice Context",
  description:
    "On a phone call, tell the agent who is on the line and how to hand off long work, before each mid-call consult.",
  register(api) {
    api.on("before_prompt_build", async (_event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      if (!isVoiceSessionKey(sessionKey)) return undefined;
      const info = await lookup(sessionKey);
      return { prependContext: buildVoiceContext(info) };
    });
  },
});

async function lookup(sessionKey) {
  const port = process.env.AGENT_HTTP_PORT || "8080";
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || "";
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/internal/voice-conversation?session_key=${encodeURIComponent(sessionKey)}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}
