import { describe, expect, it } from "vitest";

import {
  ToolCallHub,
  conversationIdFromSessionKey,
  taskIdFromSessionKey,
  type InsertToolCallRow,
  type ToolCallDB,
  type UpdateToolCallRow,
} from "./tool-telemetry.js";

/** A fake ToolCallDB that records inserts/updates and hands out sequential ids. */
function fakeDb() {
  const inserts: InsertToolCallRow[] = [];
  const updates: Array<{ id: string; patch: UpdateToolCallRow }> = [];
  let n = 0;
  const db: ToolCallDB = {
    async insertToolCall(row) {
      inserts.push(row);
      return `row-${++n}`;
    },
    async updateToolCall(id, patch) {
      updates.push({ id, patch });
      return true;
    },
  };
  return { db, inserts, updates };
}

function makeHub(enabled = true) {
  const { db, inserts, updates } = fakeDb();
  const hub = new ToolCallHub({ db, orgId: "org1", agentUid: "agent1", enabled });
  return { hub, inserts, updates };
}

describe("session-key derivation", () => {
  it("reads conversation id from webchat/a2a keys", () => {
    expect(conversationIdFromSessionKey("webchat:conv-1")).toBe("conv-1");
    expect(conversationIdFromSessionKey("a2a:conv-2")).toBe("conv-2");
    expect(conversationIdFromSessionKey("task:t-1")).toBeNull();
    expect(conversationIdFromSessionKey(null)).toBeNull();
  });

  it("reads task id from task keys", () => {
    expect(taskIdFromSessionKey("task:t-1")).toBe("t-1");
    expect(taskIdFromSessionKey("webchat:conv-1")).toBeNull();
    expect(taskIdFromSessionKey(null)).toBeNull();
  });
});

describe("ToolCallHub.recordStart", () => {
  it("uses the registered turn context to attribute and anchor the call", async () => {
    const { hub, inserts } = makeHub();
    hub.begin("webchat:conv-1", {
      conversationId: "conv-1",
      assistantMessageId: "msg-1",
      taskId: null,
    });
    await hub.recordStart({
      sessionKey: "webchat:conv-1",
      toolName: "odoo_production__sales_get_order",
      server: "odoo_production",
      argsPreview: { id: 5 },
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      orgId: "org1",
      agentUid: "agent1",
      conversationId: "conv-1",
      messageId: "msg-1",
      taskId: null,
      seq: 0,
      toolName: "odoo_production__sales_get_order",
      server: "odoo_production",
      argsPreview: { id: 5 },
    });
  });

  it("increments seq per call within a turn", async () => {
    const { hub, inserts } = makeHub();
    hub.begin("webchat:c", { conversationId: "c", assistantMessageId: "m", taskId: null });
    await hub.recordStart({ sessionKey: "webchat:c", toolName: "exec" });
    await hub.recordStart({ sessionKey: "webchat:c", toolName: "exec" });
    expect(inserts.map((r) => r.seq)).toEqual([0, 1]);
  });

  it("attributes a call even with no begin(), deriving context from the key", async () => {
    const { hub, inserts } = makeHub();
    await hub.recordStart({ sessionKey: "task:t-9", toolName: "exec" });
    expect(inserts[0]).toMatchObject({
      conversationId: null,
      taskId: "t-9",
      messageId: null,
      seq: 0,
    });
  });

  it("does nothing when disabled", async () => {
    const { hub, inserts } = makeHub(false);
    hub.begin("webchat:c", { conversationId: "c", assistantMessageId: "m", taskId: null });
    await hub.recordStart({ sessionKey: "webchat:c", toolName: "exec" });
    expect(inserts).toHaveLength(0);
  });

  it("ignores an empty tool name", async () => {
    const { hub, inserts } = makeHub();
    await hub.recordStart({ sessionKey: "webchat:c", toolName: "  " });
    expect(inserts).toHaveLength(0);
  });
});

describe("ToolCallHub.recordEnd", () => {
  it("enriches the matching row (oldest-open) with status + duration", async () => {
    const { hub, updates } = makeHub();
    hub.begin("webchat:c", { conversationId: "c", assistantMessageId: "m", taskId: null });
    await hub.recordStart({ sessionKey: "webchat:c", toolName: "exec" });
    await hub.recordEnd({ sessionKey: "webchat:c", status: "ok" });
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("row-1");
    expect(updates[0].patch.status).toBe("ok");
    expect(typeof updates[0].patch.durationMs).toBe("number");
    expect(updates[0].patch.completedAt).toBeTruthy();
  });

  it("matches by tool_call_id when supplied, out of order", async () => {
    const { hub, updates } = makeHub();
    hub.begin("webchat:c", { conversationId: "c", assistantMessageId: "m", taskId: null });
    await hub.recordStart({ sessionKey: "webchat:c", toolName: "a", toolCallId: "call-a" });
    await hub.recordStart({ sessionKey: "webchat:c", toolName: "b", toolCallId: "call-b" });
    // End the SECOND call first — id match must pick row-2, not the oldest.
    await hub.recordEnd({ sessionKey: "webchat:c", status: "error", toolCallId: "call-b" });
    expect(updates[0].id).toBe("row-2");
    expect(updates[0].patch.status).toBe("error");
  });

  it("uses the reported duration when present", async () => {
    const { hub, updates } = makeHub();
    hub.begin("webchat:c", { conversationId: "c", assistantMessageId: "m", taskId: null });
    await hub.recordStart({ sessionKey: "webchat:c", toolName: "exec" });
    await hub.recordEnd({ sessionKey: "webchat:c", status: "ok", durationMs: 1234 });
    expect(updates[0].patch.durationMs).toBe(1234);
  });

  it("is a no-op when there is no open call to match", async () => {
    const { hub, updates } = makeHub();
    hub.begin("webchat:c", { conversationId: "c", assistantMessageId: "m", taskId: null });
    await hub.recordEnd({ sessionKey: "webchat:c", status: "ok" });
    expect(updates).toHaveLength(0);
  });
});

describe("ToolCallHub.end tallies", () => {
  it("counts calls and errors for the turn", async () => {
    const { hub } = makeHub();
    hub.begin("webchat:c", { conversationId: "c", assistantMessageId: "m", taskId: null });
    await hub.recordStart({ sessionKey: "webchat:c", toolName: "a" });
    await hub.recordStart({ sessionKey: "webchat:c", toolName: "b" });
    await hub.recordEnd({ sessionKey: "webchat:c", status: "error" });
    await hub.recordEnd({ sessionKey: "webchat:c", status: "ok" });
    const totals = hub.end("webchat:c");
    expect(totals).toEqual({ count: 2, errorCount: 1 });
    // Context is gone after end().
    expect(hub.size()).toBe(0);
  });

  it("returns zeros for a session that was never begun", () => {
    const { hub } = makeHub();
    expect(hub.end("webchat:never")).toEqual({ count: 0, errorCount: 0 });
  });
});
