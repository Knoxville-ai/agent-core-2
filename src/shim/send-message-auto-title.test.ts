import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The agent turn itself: openclaw's chat-completions stream, answering one line.
vi.mock("./openclaw-gateway-fetch.js", () => ({
  fetchOpenclawStream: vi.fn(
    async () =>
      new Response(
        'data: {"choices":[{"delta":{"content":"Happy to help."}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
  ),
}));

import { handleSendMessage, type MessagesDeps } from "./routes-messages.js";
import type { AgentEnv } from "../env.js";
import type { Principal } from "./auth.js";
import type { Conversation, MessageRow, MessagingDB } from "./supabase-db.js";

const ORG = "bacon-company";
const AGENT = "560bd7e31e229d1d";
const person: Principal = { kind: "user", userId: "u1", email: null, role: null };

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    org_id: ORG,
    agent_uid: AGENT,
    user_id: "u1",
    title: null,
    archived_at: null,
    kind: "user_agent",
    drive_through_connection_id: null,
    ...over,
  };
}

/** Just the MessagingDB surface a plain text turn touches, in memory. */
function fakeDb(conv: Conversation) {
  const rows: MessageRow[] = [];
  const titles: Array<{ conversationId: string; title: string }> = [];
  const db = {
    async getConversation() {
      return conv;
    },
    async userInOrg() {
      return true;
    },
    async insertMessage(o: { role: MessageRow["role"]; content?: string; status?: string }) {
      const id = `m${rows.length + 1}`;
      rows.push({
        id,
        role: o.role,
        content: o.content ?? "",
        status: o.status ?? "complete",
        system_generated: false,
        sender_kind: null,
        sender_id: null,
        created_at: new Date().toISOString(),
      });
      return id;
    },
    async listMessages() {
      return rows.slice();
    },
    async listAttachmentsForMessages() {
      return [];
    },
    async getRecentMemories() {
      return [];
    },
    async getCallerContext() {
      return [];
    },
    async updateMessage() {},
    async setConversationTitleIfUnset(conversationId: string, title: string) {
      titles.push({ conversationId, title });
      return true;
    },
  } as unknown as MessagingDB;
  return { db, titles };
}

function fakeReq(body: unknown): IncomingMessage {
  // emitClose off: a real request's socket stays open for the whole turn.
  const req = new Readable({ read() {}, emitClose: false, autoDestroy: false });
  req.push(JSON.stringify(body));
  req.push(null);
  return Object.assign(req, { headers: {} }) as unknown as IncomingMessage;
}

function fakeRes() {
  const writes: string[] = [];
  const res = {
    writeHead: () => res,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    end: () => {},
  } as unknown as ServerResponse;
  const frames = () =>
    writes
      .filter((w) => w.startsWith("data: "))
      .map((w) => JSON.parse(w.slice("data: ".length)) as Record<string, unknown>);
  return { res, frames };
}

describe("handleSendMessage auto-title", () => {
  let stateDir: string;
  let env: AgentEnv;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "knox-auto-title-"));
    env = {
      AGENT_ORG: ORG,
      AGENT_UID: AGENT,
      LLM_PROVIDER: "openrouter",
      LLM_MODEL: "qwen/qwen3.7-plus",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_GATEWAY_PORT: 18789,
      OPENCLAW_GATEWAY_TOKEN: "gateway-token-0123456789",
      AGENT_AUTO_TITLE: true,
    } as AgentEnv;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function deps(db: MessagingDB): MessagesDeps {
    return {
      env,
      db,
      cancels: { register: () => new AbortController(), release: () => {} },
      memory: { checkpoint: async () => {} },
      delegatedCreds: { set: () => 0, clear: () => {} },
      usage: { begin: () => {}, drain: () => null },
      toolCalls: { begin: () => {}, end: () => ({ count: 0, errorCount: 0 }) },
    } as unknown as MessagesDeps;
  }

  it("names an untitled conversation alongside the reply and flags the start frame", async () => {
    const titleCall = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ text: "Reconcile June invoices", usage: {} }), { status: 200 }),
    );
    vi.stubGlobal("fetch", titleCall);
    const { db, titles } = fakeDb(conversation());
    const { res, frames } = fakeRes();

    await handleSendMessage("c1", person, fakeReq({ content: "can you reconcile the June invoices?" }), res, deps(db));

    expect(frames()[0]).toMatchObject({ type: "start", auto_title: true });
    // The reply streamed as usual.
    expect(frames()).toContainEqual({ type: "token", delta: "Happy to help." });
    expect(frames().at(-1)).toMatchObject({ type: "done", status: "complete" });

    await vi.waitFor(() => expect(titles).toEqual([{ conversationId: "c1", title: "Reconcile June invoices" }]));
    expect(titleCall).toHaveBeenCalledTimes(1);
    const [url, init] = titleCall.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:18789/knox/llm-complete");
    expect(String(init.body)).toContain("can you reconcile the June invoices?");
  });

  it("leaves a titled conversation alone and says nothing about titles", async () => {
    const titleCall = vi.fn();
    vi.stubGlobal("fetch", titleCall);
    const { db, titles } = fakeDb(conversation({ title: "Q3 forecast" }));
    const { res, frames } = fakeRes();

    await handleSendMessage("c1", person, fakeReq({ content: "update it" }), res, deps(db));

    expect(frames()[0]).toEqual({ type: "start", user_message_id: "m1", assistant_message_id: "m2" });
    expect(titleCall).not.toHaveBeenCalled();
    expect(titles).toEqual([]);
  });

  it("keeps the turn whole when the title call fails, and names it from the message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { db, titles } = fakeDb(conversation());
    const { res, frames } = fakeRes();

    await handleSendMessage("c1", person, fakeReq({ content: "Hey, can you draft a reply to Acme?" }), res, deps(db));

    expect(frames().at(-1)).toMatchObject({ type: "done", status: "complete" });
    await vi.waitFor(() => expect(titles).toEqual([{ conversationId: "c1", title: "Draft a reply to Acme" }]));
  });
});
