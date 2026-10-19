import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { messagesIn, startMcpRelay, toolCallsIn, type McpRelayHandle } from "./mcp-relay.js";
import type { GuardVerdict, ProcessEvents, ToolCallReport } from "./process-events.js";

// The relay between a skill script and the Odoo MCP server: every byte goes
// through unchanged, declared writes are guarded first and reported after.

/** A fake Odoo MCP server: answers tools/call as JSON, or as SSE when asked. */
let upstream: Server;
let upstreamUrl = "";
const seen: Array<{ path: string; headers: IncomingMessage["headers"]; body: string }> = [];

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", headers: req.headers, body });
      const msg = body ? JSON.parse(body) : {};
      const result = { content: [{ type: "text", text: JSON.stringify({ id: 301, state: "sale" }) }] };
      if (req.headers.accept?.includes("text/event-stream")) {
        res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s-1" });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-1" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      }
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp/v1`;
});
afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
});

/** A reporter stand-in: declares sales_confirm_order on odoo-mcp, with a settable verdict. */
function fakeEvents(verdict: GuardVerdict = { allowed: true, reason: null }) {
  const guards: unknown[] = [];
  const records: ToolCallReport[] = [];
  let settle: () => void = () => {};
  const recorded = new Promise<void>((r) => (settle = r));
  const events = {
    async declaredSurface(t: { surface?: string; tool: string }) {
      return t.surface === "odoo-mcp" && t.tool === "sales_confirm_order" ? "odoo-mcp" : null;
    },
    async guard(t: unknown, args: unknown) {
      guards.push({ t, args });
      return verdict;
    },
    async record(r: ToolCallReport) {
      records.push(r);
      settle();
    },
  } as unknown as ProcessEvents;
  return { events, guards, records, recorded };
}

const call = (id: number, name: string, args: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

async function withRelay<T>(events: ProcessEvents, fn: (url: string, relay: McpRelayHandle) => Promise<T>): Promise<T> {
  const relay = await startMcpRelay("ODOO_MCP_URL=odoo-mcp", { ODOO_MCP_URL: upstreamUrl }, events);
  expect(relay).not.toBeNull();
  try {
    return await fn(relay!.envOverrides.ODOO_MCP_URL!, relay!);
  } finally {
    await relay!.close();
  }
}

describe("JSON-RPC parsing", () => {
  it("finds tools/call requests in one message or a batch", () => {
    expect(toolCallsIn(JSON.parse(call(1, "sales_confirm_order", { order_id: 1 })))).toEqual([
      { id: 1, tool: "sales_confirm_order", args: { order_id: 1 } },
    ]);
    expect(toolCallsIn([{ jsonrpc: "2.0", id: 2, method: "initialize" }, JSON.parse(call(3, "x", {}))])).toHaveLength(1);
    expect(toolCallsIn("nope")).toEqual([]);
  });
  it("reads responses as JSON or as SSE frames", () => {
    expect(messagesIn("application/json", '{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
    expect(messagesIn("text/event-stream", 'event: message\ndata: {"id":2}\n\ndata: {"id":3}\n\n')).toEqual([{ id: 2 }, { id: 3 }]);
    expect(messagesIn("application/json", "not json")).toEqual([]);
  });
});

describe("the relay", () => {
  it("only relays the env vars that hold a URL", async () => {
    const { events } = fakeEvents();
    expect(await startMcpRelay("ODOO_MCP_URL=odoo-mcp", {}, events)).toBeNull();
    expect(await startMcpRelay("", { ODOO_MCP_URL: upstreamUrl }, events)).toBeNull();
  });

  it("forwards a write unchanged, then reports it with its result", async () => {
    const { events, guards, records, recorded } = fakeEvents();
    await withRelay(events, async (url) => {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/odoo_mcp_url$/);
      const body = call(7, "sales_confirm_order", { order_id: 88, confirm: true });
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "mcp-session-id": "s-1" },
        body,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("mcp-session-id")).toBe("s-1");
      const answer = await res.json();
      expect(answer.id).toBe(7);
      const last = seen.at(-1)!;
      expect(last.path).toBe("/mcp/v1");
      expect(last.body).toBe(body);
      expect(last.headers["mcp-session-id"]).toBe("s-1");
      expect(last.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
      await recorded;
    });
    expect(guards).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ surface: "odoo-mcp", tool: "sales_confirm_order", args: { order_id: 88, confirm: true }, isError: false });
    expect(records[0]!.callId).toMatch(/^relay:/);
    expect(records[0]!.result).toEqual({ content: [{ type: "text", text: JSON.stringify({ id: 301, state: "sale" }) }] });
  });

  it("reads an SSE answer too", async () => {
    const { events, records, recorded } = fakeEvents();
    await withRelay(events, async (url) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: call(8, "sales_confirm_order", { order_id: 89, confirm: true }),
      });
      expect(await res.text()).toContain('"id":8');
      await recorded;
    });
    expect(records[0]).toMatchObject({ tool: "sales_confirm_order", args: { order_id: 89, confirm: true } });
  });

  it("neither guards nor reports undeclared tools, and keeps the rest of the path", async () => {
    const { events, guards, records } = fakeEvents();
    await withRelay(events, async (url) => {
      const res = await fetch(`${url}/extra?x=1`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: call(9, "sales_get_order", { order_id: 1 }),
      });
      await res.json();
    });
    expect(seen.at(-1)!.path).toBe("/mcp/v1/extra?x=1");
    expect(guards).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  it("answers a refused write itself, without forwarding it", async () => {
    const { events, records } = fakeEvents({ allowed: false, reason: "write capabilities are not allowed for diligence tenants" });
    const before = seen.length;
    await withRelay(events, async (url) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: call(10, "sales_confirm_order", { order_id: 88, confirm: true }),
      });
      const answer = await res.json();
      expect(answer).toMatchObject({ id: 10, result: { isError: true } });
      expect(answer.result.content[0].text).toMatch(/diligence/);
    });
    expect(seen.length).toBe(before);
    expect(records).toHaveLength(0);
  });
});
