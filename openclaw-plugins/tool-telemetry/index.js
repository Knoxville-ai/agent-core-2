import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { count, redactArgs, serverFromToolName, truncateError } from "./redact.js";

/**
 * Knox tool-telemetry — surfaces and records every tool call the agent makes.
 *
 * Why this exists
 * ---------------
 * OpenClaw runs the agentic tool loop INTERNALLY. The shim talks to it over the
 * OpenAI-compat `/v1/chat/completions` endpoint, whose stream carries only
 * assistant *content* deltas — the tool calls the model makes never appear on it
 * (see `iterOpenaiDeltas` in src/shim/routes-messages.ts). So the platform has
 * had no way to see WHEN or WHAT tools an agent called: they were invisible in
 * the session, absent from the database, and impossible to report or bill on.
 *
 * The `before_tool_call` hook fires once per tool invocation, one level below
 * the chat stream, with the tool name and params intact — the same hook the
 * delegated-credentials / report-outcome / task-progress plugins already use.
 * We forward a small, REDACTED record of each call to the shim over the same
 * loopback + gateway-token channel the usage-telemetry plugin uses. The shim
 * persists it to `agent_tool_calls` (keyed to the live turn's conversation /
 * task / assistant message) and the console renders it live via realtime — the
 * same "tool call card" treatment a coding assistant gives its own tools.
 *
 * `after_tool_call` (best-effort) enriches the row with the call's outcome
 * (ok / error) and duration. If the running OpenClaw does not fire it, the row
 * simply stays `status='called'` — still a complete audit + billing signal.
 *
 * Boundaries this plugin keeps:
 *   - Fire-and-forget. A failed or slow POST must never delay or break a tool
 *     call, so every error is swallowed and the request is not awaited on the
 *     tool's critical path.
 *   - REDACTED by construction. Arguments are run through `redactArgs` HERE,
 *     inside the gateway, before anything crosses the loopback — credential-
 *     shaped keys (and the exec `env` bag brokered creds land in) are withheld,
 *     and everything is size-bounded. It rewrites nothing: unlike the injector
 *     plugins it returns void from `before_tool_call`, so the tool call itself
 *     is untouched.
 *   - Per-session attribution. The shim maps `ctx.sessionKey`
 *     (`webchat:` / `a2a:` / `task:`) to the turn it opened, so a call is always
 *     attributed to the right conversation or task and never leaks across turns.
 */

const POST_TIMEOUT_MS = 2000;

/** Build the loopback ingest URL + auth for the shim's `/internal/tool-call`
 *  route. Read at CALL time, not module load: OpenClaw evaluates plugin modules
 *  in more than one realm during a run, and a realm evaluated before the env was
 *  populated would otherwise bind an empty token forever (mirrors the
 *  usage-telemetry and delegated-credentials plugins). */
function loopbackConfig() {
  const port = process.env.AGENT_HTTP_PORT || "8080";
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || "";
  return { token, url: `http://127.0.0.1:${port}/internal/tool-call` };
}

/** POST one event to the shim. Never throws, never blocks a tool call. */
async function report(body) {
  const { token, url } = loopbackConfig();
  if (!token) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* fail open — telemetry must never cost a tool call */
  }
}

/** True when an `after_tool_call` event reports the call failed.
 *
 * The authoritative signal in openclaw 2026.5.20 is `event.error` (a non-empty
 * string set only on failure — see PluginHookAfterToolCallEvent). The remaining
 * checks are defensive across openclaw versions/shapes; we default to success
 * only when nothing says otherwise. */
function isError(event) {
  if (!event || typeof event !== "object") return false;
  if (typeof event.error === "string" && event.error.trim()) return true;
  if (event.isError === true || event.ok === false || event.success === false) return true;
  if (typeof event.status === "string" && /error|fail/i.test(event.status)) return true;
  const result = event.result;
  if (result && typeof result === "object" && result.isError === true) return true;
  return false;
}

/** A tool_call id off the event, when the runtime supplies one. Purely for
 *  reference/correlation; the shim also matches by session recency, so a missing
 *  id never breaks enrichment. */
function toolCallId(event) {
  return (
    (typeof event?.toolCallId === "string" && event.toolCallId) ||
    (typeof event?.tool_call_id === "string" && event.tool_call_id) ||
    (typeof event?.id === "string" && event.id) ||
    null
  );
}

export default definePluginEntry({
  id: "knox-tool-telemetry",
  name: "Knox Tool Telemetry",
  description:
    "Forward each tool call the agent makes (name + redacted args, then outcome) to the agent-core shim over loopback, so tool use is surfaced in the session and recorded for audit and billing.",
  register(api) {
    // START: one record per tool invocation, with a redacted arg preview.
    api.on(
      "before_tool_call",
      async (event, ctx) => {
        const toolName = event?.toolName;
        if (typeof toolName !== "string" || !toolName) return;
        await report({
          phase: "start",
          session_key: ctx?.sessionKey ?? event?.sessionKey ?? null,
          tool_name: toolName,
          server: serverFromToolName(toolName),
          tool_call_id: toolCallId(event),
          args_preview: redactArgs(event?.params),
        });
        // Return nothing: observe-only, the tool call is not modified.
      },
      { priority: 20 },
    );

    // END (best-effort): enrich the row with outcome + duration. Harmless if the
    // running OpenClaw never fires this event — the row stays `status='called'`.
    api.on(
      "after_tool_call",
      async (event, ctx) => {
        const toolName = event?.toolName;
        if (typeof toolName !== "string" || !toolName) return;
        const errored = isError(event);
        await report({
          phase: "end",
          session_key: ctx?.sessionKey ?? event?.sessionKey ?? null,
          tool_name: toolName,
          tool_call_id: toolCallId(event),
          status: errored ? "error" : "ok",
          // A bounded diagnostic on failure only — the "what went wrong" half of
          // the audit trail. Kept (not redacted) but length-capped; see redact.js.
          error: errored ? truncateError(event?.error) : null,
          duration_ms: count(event?.durationMs ?? event?.duration_ms),
        });
      },
      { priority: 20 },
    );
  },
});
