# knox-process-events

Guards and reports an agent's calls to the MCP write tools the console declares
(its `spec/registry/tool-actions/`), so they become events on the company's
process map with the agent as actor. See `CONSOLE_INTEGRATION.md`, "Process
events".

- `before_tool_call` → `POST /internal/process-events/guard` on the shim. Built-in
  and undeclared tools are answered at once; declared writes are checked by the
  console. Only an explicit refusal blocks (the console refuses only while it
  enforces); a timeout or error lets the call run.
- `after_tool_call` → `POST /internal/process-events/record`; the shim reports
  the call to the console in the background.

Skill scripts that call MCP themselves are covered by the shim's MCP relay
(`src/shim/mcp-relay.ts`), not by this plugin.

Wired by `src/provision/render-workspace.ts` when the platform MCP is configured
and `PROCESS_EVENTS` is on (the default).
