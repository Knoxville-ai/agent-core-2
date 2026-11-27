import { describe, expect, it, vi } from "vitest";

import {
  approvalArgs,
  approvalReference,
  consoleHostedServers,
  ToolApprovalGate,
  type ApprovalAsker,
  type ApprovalRow,
  type ApprovalStore,
} from "./tool-approvals.js";
import type { SessionVerdict } from "./session-policy.js";

const AGENT = "0123456789abcdef";
const KEY = "k".repeat(64);
const SESSION: SessionVerdict = { channel: "trusted", conversationId: "c1", taskId: null };
const NOW = Date.parse("2026-11-26T12:00:00Z");
const TOOL = "odoo_production__sales_confirm_order";

function gate(rows: ApprovalRow[] = [], over: { claim?: boolean; find?: ApprovalStore["find"]; hosted?: string[] } = {}) {
  const store: ApprovalStore = {
    find: vi.fn(over.find ?? (async () => rows)),
    claim: vi.fn(async () => over.claim ?? true),
  };
  const asker: ApprovalAsker = { ask: vi.fn(async () => "esc-1") };
  const g = new ToolApprovalGate({
    agentUid: AGENT,
    escalated: ["odoo_production__sales_confirm_order", "quickbooks__create_bill"],
    servers: ["odoo_production", "quickbooks"],
    consoleHosted: new Set(over.hosted ?? ["quickbooks"]),
    key: KEY,
    store,
    asker,
    now: () => NOW,
  });
  return { g, store, asker };
}

const args = { order_id: 42 };

describe("ToolApprovalGate", () => {
  it("only gates escalated tools of servers the agent reaches directly", () => {
    const { g } = gate();
    expect(g.gatedToken(TOOL)).toEqual({ token: TOOL, server: "odoo_production" });
    // The console-hosted connector checks its own approvals.
    expect(g.gatedToken("quickbooks__create_bill")).toBeNull();
    expect(g.gatedToken("odoo_production__sales_get_order")).toBeNull();
    expect(g.gatedToken("exec")).toBeNull();
  });

  it("a gated call with no approval isn't run: the runtime asks for one, bound to the exact call", async () => {
    const { g, asker } = gate();
    const d = await g.check(TOOL, { ...args, _knox_session: "webchat:c1" }, SESSION);
    expect(d.allow).toBe(false);
    expect(!d.allow && d.reason).toMatch(/Approval was requested \(esc-1\)/);
    expect(asker.ask).toHaveBeenCalledTimes(1);
    const asked = (asker.ask as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(asked.session).toEqual(SESSION);
    expect(asked.context).toContain('"order_id": 42');
    expect(asked.context).not.toContain("_knox_session");
    expect(asked.context).toContain(approvalReference(KEY, AGENT, TOOL, args));
  });

  it("an approved, fresh, unused approval runs the call once", async () => {
    const { g, store } = gate([{ id: "e1", state: "answered", answer_text: "Approve", resolved_at: "2026-11-26T11:00:00Z" }]);
    expect(await g.check(TOOL, args, SESSION)).toEqual({ allow: true });
    expect(store.claim).toHaveBeenCalledWith("e1");
    expect(store.find).toHaveBeenCalledWith(AGENT, approvalReference(KEY, AGENT, TOOL, args));
  });

  it("an approval another call already used refuses", async () => {
    const { g } = gate([{ id: "e1", state: "answered", answer_text: "Approve", resolved_at: "2026-11-26T11:00:00Z" }], {
      claim: false,
    });
    expect((await g.check(TOOL, args, SESSION)).allow).toBe(false);
  });

  it("waiting or denied refuses without asking again", async () => {
    const waiting = gate([{ id: "e1", state: "pending", answer_text: null, resolved_at: null }]);
    const w = await waiting.g.check(TOOL, args, SESSION);
    expect(!w.allow && w.reason).toMatch(/hasn't been answered/);
    expect(waiting.asker.ask).not.toHaveBeenCalled();
    const denied = gate([{ id: "e1", state: "answered", answer_text: "Deny, not today", resolved_at: "2026-11-26T11:00:00Z" }]);
    const d = await denied.g.check(TOOL, args, SESSION);
    expect(!d.allow && d.reason).toMatch(/wasn't approved/);
    expect(denied.asker.ask).not.toHaveBeenCalled();
  });

  it("an approval older than 24 hours doesn't count: a new one is asked for", async () => {
    const { g, asker, store } = gate([{ id: "e1", state: "answered", answer_text: "Approve", resolved_at: "2026-11-25T11:00:00Z" }]);
    expect((await g.check(TOOL, args, SESSION)).allow).toBe(false);
    expect(store.claim).not.toHaveBeenCalled();
    expect(asker.ask).toHaveBeenCalled();
  });

  it("an approval for other arguments is a different reference", () => {
    expect(approvalReference(KEY, AGENT, TOOL, { order_id: 42 })).not.toBe(approvalReference(KEY, AGENT, TOOL, { order_id: 43 }));
    expect(approvalReference(KEY, AGENT, TOOL, { a: 1, b: 2 })).toBe(approvalReference(KEY, AGENT, TOOL, { b: 2, a: 1 }));
    expect(approvalReference("other-key", AGENT, TOOL, args)).not.toBe(approvalReference(KEY, AGENT, TOOL, args));
  });

  it("fails closed: a lookup that errors, no store, no session to park, or arguments too long to show", async () => {
    const failing = gate([], {
      find: async () => {
        throw new Error("db down");
      },
    });
    expect((await failing.g.check(TOOL, args, SESSION)).allow).toBe(false);
    const noStore = new ToolApprovalGate({
      agentUid: AGENT,
      escalated: [TOOL],
      servers: ["odoo_production"],
      consoleHosted: new Set(),
      key: KEY,
      store: null,
      asker: null,
    });
    expect((await noStore.check(TOOL, args, SESSION)).allow).toBe(false);
    const nowhere = gate();
    expect((await nowhere.g.check(TOOL, args, { channel: "trusted", conversationId: null, taskId: null })).allow).toBe(false);
    expect(nowhere.asker.ask).not.toHaveBeenCalled();
    const long = gate();
    expect((await long.g.check(TOOL, { note: "x".repeat(5000) }, SESSION)).allow).toBe(false);
    expect(long.asker.ask).not.toHaveBeenCalled();
  });

  it("ungated tools pass untouched", async () => {
    const { g, store } = gate();
    expect(await g.check("odoo_production__sales_get_order", args, SESSION)).toEqual({ allow: true });
    expect(store.find).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("approvalArgs leaves out the runtime's session stamp", () => {
    expect(approvalArgs({ a: 1, _knox_session: "webchat:c" })).toEqual({ a: 1 });
    expect(approvalArgs(null)).toEqual({});
  });

  it("consoleHostedServers recognizes the console's connector endpoints only", () => {
    const servers = JSON.stringify({
      quickbooks: { url: "https://console.example/api/mcp/quickbooks/0d7e1c9a-0000-4000-8000-000000000000" },
      // How the console writes a managed connector (managed-servers.ts).
      github: { url: "${PLATFORM_MCP_URL}/github/0d7e1c9a-0000-4000-8000-000000000001" },
      odoo: { url: "https://odoo.example/mcp" },
      lookalike: { url: "https://console.example.evil/api/mcp/x" },
    });
    expect([...consoleHostedServers(servers, "https://console.example/api/mcp")]).toEqual(["quickbooks", "github"]);
    expect([...consoleHostedServers(servers, undefined)]).toEqual([]);
  });
});
