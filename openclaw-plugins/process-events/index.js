import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Knox process events — the openclaw half of the console's agent event hook
 * (console phase 5, spec DECISIONS 64).
 *
 * The console declares which MCP write tools change business records (its
 * spec/registry/tool-actions/). For a call to one of them this plugin:
 *
 *   before_tool_call  asks the shim whether it may run
 *                     (/internal/process-events/guard). The shim answers at
 *                     once for built-in and undeclared tools, and asks the
 *                     console for declared writes. Only an explicit refusal
 *                     blocks — the console sends one only while it enforces —
 *                     and any error or timeout lets the call run.
 *   after_tool_call   hands the call and its result to the shim
 *                     (/internal/process-events/record), which reports it to
 *                     the console in the background. The console turns it into
 *                     kernel events with this agent as actor, so the agent's
 *                     work shows on the company's process map.
 *
 * Unlike knox-tool-telemetry this plugin reads raw params and results: the
 * console needs the record IDs in them. They go only to the shim over
 * loopback, and from the shim to the console the agent already talks to.
 * Nothing is logged here.
 */

const GUARD_TIMEOUT_MS = 4000;
const RECORD_TIMEOUT_MS = 2000;

/** Read at CALL time (see knox-tool-telemetry for why). */
function loopback(path) {
  const port = process.env.AGENT_HTTP_PORT || "8080";
  return { token: process.env.OPENCLAW_GATEWAY_TOKEN || "", url: `http://127.0.0.1:${port}${path}` };
}

async function post(path, body, timeoutMs) {
  const { token, url } = loopback(path);
  if (!token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res.ok ? await res.json().catch(() => null) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Only MCP tools (`<server>__<tool>`) can be declared; built-ins skip the loopback entirely. */
const isMcpTool = (name) => typeof name === "string" && /^[a-zA-Z0-9_-]+?__.+/.test(name) && !name.startsWith("knoxville_platform__");

export default definePluginEntry({
  id: "knox-process-events",
  name: "Knox Process Events",
  description:
    "Guard and report agents' calls to declared MCP write tools, so they become events on the company's process map.",
  register(api) {
    api.on(
      "before_tool_call",
      async (event) => {
        if (!isMcpTool(event?.toolName)) return;
        const verdict = await post(
          "/internal/process-events/guard",
          { tool_name: event.toolName, params: event.params ?? {} },
          GUARD_TIMEOUT_MS,
        );
        if (verdict && verdict.allowed === false) {
          return { block: true, blockReason: `Refused by the platform: ${verdict.reason || "not allowed for this company"}` };
        }
      },
      { priority: 30 },
    );

    api.on(
      "after_tool_call",
      async (event) => {
        if (!isMcpTool(event?.toolName)) return;
        await post(
          "/internal/process-events/record",
          {
            tool_name: event.toolName,
            params: event.params ?? {},
            result: event.result ?? null,
            error: typeof event.error === "string" ? event.error : null,
            tool_call_id: typeof event.toolCallId === "string" ? event.toolCallId : null,
            run_id: typeof event.runId === "string" ? event.runId : null,
          },
          RECORD_TIMEOUT_MS,
        );
      },
      { priority: 30 },
    );
  },
});
