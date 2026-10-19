import { describe, expect, it } from "vitest";

import type { ToolCallResult } from "../bundle/client.js";
import { parseRelayMap, ProcessEvents, splitToolName, type BrokerClient } from "./process-events.js";

const DECLARATIONS = {
  surfaces: { "odoo-mcp": { tools: ["sales_confirm_order", "replenish_confirm_po"] } },
  servers: { odoo_production: "odoo-mcp" },
};

const ok = (structuredContent: unknown): ToolCallResult => ({ content: [{ type: "text", text: "ok" }], structuredContent });

/** A fake platform MCP: answers the three broker tools and records what it was asked. */
function fakeClient(handlers: Partial<Record<string, (args: unknown) => ToolCallResult | Promise<ToolCallResult>>> = {}) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const client: BrokerClient = {
    async callTool(name, args) {
      calls.push({ name, args });
      const h = handlers[name];
      if (h) return await h(args);
      if (name === "get_tool_actions") return ok(DECLARATIONS);
      if (name === "guard_tool_call") return ok({ allowed: true, would_allow: true, enforced: false, reason: null });
      if (name === "record_tool_call") return ok({ declared: true, events: [{ event_id: "ev_1" }], skipped: [] });
      throw new Error(`unexpected ${name}`);
    },
  };
  return { client, calls };
}

const noSleep = async () => {};

describe("splitToolName", () => {
  it("splits openclaw's <server>__<tool> and skips built-ins and the platform's own server", () => {
    expect(splitToolName("odoo_production__sales_confirm_order")).toEqual({ server: "odoo_production", tool: "sales_confirm_order" });
    expect(splitToolName("exec")).toBeNull();
    expect(splitToolName("knoxville_platform__send_email")).toBeNull();
  });
});

describe("parseRelayMap", () => {
  it("reads VAR=surface pairs and drops junk", () => {
    expect(parseRelayMap("ODOO_MCP_URL=odoo-mcp, X=Bad Surface,=y, OTHER_URL=other")).toEqual([
      ["ODOO_MCP_URL", "odoo-mcp"],
      ["OTHER_URL", "other"],
    ]);
    expect(parseRelayMap("")).toEqual([]);
  });
});

describe("ProcessEvents", () => {
  it("knows a declared tool by server or surface, and caches the declarations", async () => {
    const { client, calls } = fakeClient();
    const events = new ProcessEvents(client, "1.0.0");
    expect(await events.declaredSurface({ server: "odoo_production", tool: "sales_confirm_order" })).toBe("odoo-mcp");
    expect(await events.declaredSurface({ surface: "odoo-mcp", tool: "replenish_confirm_po" })).toBe("odoo-mcp");
    expect(await events.declaredSurface({ server: "odoo_production", tool: "sales_get_order" })).toBeNull();
    expect(await events.declaredSurface({ server: "other", tool: "sales_confirm_order" })).toBeNull();
    expect(calls.filter((c) => c.name === "get_tool_actions")).toHaveLength(1);
  });

  it("allows undeclared tools without asking, and asks for declared writes", async () => {
    const { client, calls } = fakeClient();
    const events = new ProcessEvents(client, "1.0.0");
    expect(await events.guard({ server: "odoo_production", tool: "sales_get_order" }, {})).toEqual({ allowed: true, reason: null });
    expect(calls.some((c) => c.name === "guard_tool_call")).toBe(false);
    await events.guard({ server: "odoo_production", tool: "sales_confirm_order" }, { order_id: 88, confirm: true });
    expect(calls.find((c) => c.name === "guard_tool_call")?.args).toEqual({
      surface: "odoo-mcp", tool: "sales_confirm_order", args: { order_id: 88, confirm: true },
    });
  });

  it("blocks only on the console's refusal, and fails open", async () => {
    const refused = new ProcessEvents(
      fakeClient({ guard_tool_call: () => ok({ allowed: false, would_allow: false, enforced: true, reason: "write capabilities are not allowed for diligence tenants" }) }).client,
      "1.0.0",
    );
    expect(await refused.guard({ surface: "odoo-mcp", tool: "sales_confirm_order" }, {})).toEqual({
      allowed: false, reason: "write capabilities are not allowed for diligence tenants",
    });
    const logged = new ProcessEvents(
      fakeClient({ guard_tool_call: () => ok({ allowed: true, would_allow: false, enforced: false, reason: "no grant" }) }).client,
      "1.0.0",
    );
    expect((await logged.guard({ surface: "odoo-mcp", tool: "sales_confirm_order" }, {})).allowed).toBe(true);
    const down = new ProcessEvents(fakeClient({ guard_tool_call: () => { throw new Error("ECONNREFUSED"); } }).client, "1.0.0");
    expect((await down.guard({ surface: "odoo-mcp", tool: "sales_confirm_order" }, {})).allowed).toBe(true);
    const noDecl = new ProcessEvents(fakeClient({ get_tool_actions: () => { throw new Error("down"); } }).client, "1.0.0");
    expect((await noDecl.guard({ surface: "odoo-mcp", tool: "sales_confirm_order" }, {})).allowed).toBe(true);
  });

  it("reports declared calls with the runtime version, retries, and drops undeclared ones", async () => {
    let failures = 2;
    const { client, calls } = fakeClient({
      record_tool_call: () => {
        if (failures-- > 0) throw new Error("503");
        return ok({ declared: true, events: [], skipped: [] });
      },
    });
    const events = new ProcessEvents(client, "1.2.3", Date.now, noSleep);
    const base = { args: { po_id: 7 }, isError: false, callId: "relay:abc", finishedAt: "2026-10-20T16:00:03Z" };
    await events.record({ ...base, server: "odoo_production", tool: "replenish_confirm_po" });
    const records = calls.filter((c) => c.name === "record_tool_call");
    expect(records).toHaveLength(3);
    expect(records[2]!.args).toMatchObject({
      surface: "odoo-mcp", tool: "replenish_confirm_po", call_id: "relay:abc", runtime_version: "1.2.3", is_error: false,
    });
    await events.record({ ...base, server: "odoo_production", tool: "sales_get_order" });
    expect(calls.filter((c) => c.name === "record_tool_call")).toHaveLength(3);
  });

  it("gives up after its retries without throwing", async () => {
    const { client, calls } = fakeClient({ record_tool_call: () => { throw new Error("down"); } });
    const events = new ProcessEvents(client, "1.0.0", Date.now, noSleep);
    await expect(
      events.record({ surface: "odoo-mcp", tool: "sales_confirm_order", args: {}, isError: false, callId: "x", finishedAt: "t" }),
    ).resolves.toBeUndefined();
    expect(calls.filter((c) => c.name === "record_tool_call")).toHaveLength(4);
  });
});
