import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// openclaw's chat-completions stream, driven by the test one chunk at a time.
const gateway = vi.hoisted(() => ({
  calls: [] as Array<{ messages: Array<{ role: string; content: unknown }> }>,
  streams: [] as Array<ReadableStreamDefaultController<Uint8Array>>,
}));
vi.mock("./openclaw-gateway-fetch.js", () => ({
  fetchOpenclawStream: vi.fn(async (_url: string, init: RequestInit) => {
    gateway.calls.push(JSON.parse(String(init.body)));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        gateway.streams.push(controller);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }),
}));

import { CancelRegistry } from "./cancel-registry.js";
import { handleSendMessage, type MessagesDeps } from "./routes-messages.js";
import { TurnLocks, type TurnEvent, type TurnPublisher } from "./turn-live.js";
import type { AgentEnv } from "../env.js";
import type { Principal } from "./auth.js";
import type { Conversation, MessageRow, MessagingDB } from "./supabase-db.js";

const ORG = "bacon-company";
const AGENT = "560bd7e31e229d1d";
const person: Principal = { kind: "user", userId: "u1", email: null, role: null };
const enc = new TextEncoder();

function say(i: number, text: string): void {
  gateway.streams[i]!.enqueue(
    enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`),
  );
}
function finish(i: number): void {
  gateway.streams[i]!.enqueue(enc.encode("data: [DONE]\n\n"));
  gateway.streams[i]!.close();
}

/** Wait until `pred` holds, yielding to the event loop between checks. */
async function until(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function conversation(): Conversation {
  return {
    id: "c1",
    org_id: ORG,
    agent_uid: AGENT,
    user_id: "u1",
    title: "Already named",
    archived_at: null,
    kind: "user_agent",
    drive_through_connection_id: null,
  };
}

/** The MessagingDB surface a text turn touches, in memory. */
function fakeDb() {
  const rows: MessageRow[] = [];
  const saves: Array<{ id: string; content: string }> = [];
  const db = {
    async getConversation() {
      return conversation();
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
    async updateMessage(id: string, o: { content?: string; status?: string }) {
      const row = rows.find((r) => r.id === id)!;
      if (o.content !== undefined) row.content = o.content;
      if (o.status !== undefined) row.status = o.status;
      return true;
    },
    async saveStreamingContent(id: string, content: string) {
      const row = rows.find((r) => r.id === id)!;
      if (row.status !== "streaming") return true;
      row.content = content;
      saves.push({ id, content });
      return true;
    },
    async listMessages() {
      return rows.map((r) => ({ ...r }));
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
  } as unknown as MessagingDB;
  return { db, rows, saves };
}

function fakeReq(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const req = new Readable({ read() {}, emitClose: false, autoDestroy: false });
  req.push(JSON.stringify(body));
  req.push(null);
  return Object.assign(req, { headers }) as unknown as IncomingMessage;
}

function fakeRes() {
  const emitter = new EventEmitter();
  const writes: string[] = [];
  let status = 0;
  let ended: string | undefined;
  const res = Object.assign(emitter, {
    writeHead: (s: number) => {
      status = s;
      return res;
    },
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    end: (chunk?: string) => {
      ended = chunk;
    },
  }) as unknown as ServerResponse;
  const frames = () =>
    writes
      .filter((w) => w.startsWith("data: "))
      .map((w) => JSON.parse(w.slice("data: ".length)) as Record<string, unknown>);
  return {
    res,
    frames,
    status: () => status,
    body: () => (ended ? (JSON.parse(ended) as Record<string, unknown>) : null),
    disconnect: () => emitter.emit("close"),
  };
}

describe("handleSendMessage turn lifecycle", () => {
  let stateDir: string;
  let env: AgentEnv;
  let published: TurnEvent[];
  let cancels: CancelRegistry;
  let turns: TurnLocks;

  beforeEach(() => {
    gateway.calls.length = 0;
    gateway.streams.length = 0;
    published = [];
    cancels = new CancelRegistry();
    turns = new TurnLocks();
    stateDir = mkdtempSync(join(tmpdir(), "knox-turn-lifecycle-"));
    env = {
      AGENT_ORG: ORG,
      AGENT_UID: AGENT,
      LLM_PROVIDER: "openrouter",
      LLM_MODEL: "qwen/qwen3.7-plus",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_GATEWAY_PORT: 18789,
      OPENCLAW_GATEWAY_TOKEN: "gateway-token-0123456789",
      AGENT_AUTO_TITLE: false,
    } as AgentEnv;
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  function deps(db: MessagingDB): MessagesDeps {
    const publisher: TurnPublisher = {
      async publish(_topic, events) {
        published.push(...events);
      },
    };
    return {
      env,
      db,
      cancels,
      memory: { checkpoint: async () => {} },
      delegatedCreds: { set: () => 0, clear: () => {} },
      usage: { begin: () => {}, drain: () => null },
      toolCalls: { begin: () => {}, end: () => ({ count: 0, errorCount: 0 }) },
      turns,
      publisher,
    } as unknown as MessagesDeps;
  }

  it("keeps the turn running after the client disconnects", async () => {
    const { db, rows } = fakeDb();
    const r = fakeRes();
    const turn = handleSendMessage("c1", person, fakeReq({ content: "hi" }), r.res, deps(db));
    await until(() => gateway.streams.length === 1, "gateway call");
    say(0, "Hello ");
    await until(() => r.frames().some((f) => f.type === "token"), "first token");
    r.disconnect();
    say(0, "after you left.");
    finish(0);
    await turn;

    const reply = rows.find((row) => row.role === "assistant")!;
    expect(reply).toMatchObject({ status: "complete", content: "Hello after you left." });
    // Nothing was written to the socket after it closed.
    expect(r.frames().map((f) => f.type)).toEqual(["start", "token"]);
    expect(published.at(-1)).toMatchObject({ type: "done", status: "complete" });
  });

  it("answers 202 with the ids under Prefer: respond-async and finishes the turn detached", async () => {
    const { db, rows } = fakeDb();
    const r = fakeRes();
    const turn = handleSendMessage(
      "c1",
      person,
      fakeReq({ content: "hi" }, { prefer: "respond-async" }),
      r.res,
      deps(db),
    );
    await until(() => r.status() === 202, "202");
    expect(r.body()).toEqual({ ok: true, user_message_id: "m1", assistant_message_id: "m2" });
    expect(r.frames()).toEqual([]);

    await until(() => gateway.streams.length === 1, "gateway call");
    say(0, "Done.");
    finish(0);
    await turn;
    expect(rows[1]).toMatchObject({ id: "m2", status: "complete", content: "Done." });
    expect(published.map((e) => e.type)).toEqual(["start", "token", "done"]);
    expect(published[1]).toEqual({ type: "token", message_id: "m2", offset: 0, delta: "Done." });
  });

  it("saves the reply into the row while it streams", async () => {
    const { db, saves } = fakeDb();
    const r = fakeRes();
    const turn = handleSendMessage("c1", person, fakeReq({ content: "hi" }), r.res, deps(db));
    await until(() => gateway.streams.length === 1, "gateway call");
    say(0, "Partial");
    await until(() => saves.length > 0, "a streaming save");
    expect(saves[0]).toEqual({ id: "m2", content: "Partial" });
    finish(0);
    await turn;
  }, 10_000);

  it("queues a second turn behind the first and builds it on the finished reply", async () => {
    const { db, rows } = fakeDb();
    const first = handleSendMessage("c1", person, fakeReq({ content: "one" }), fakeRes().res, deps(db));
    await until(() => gateway.streams.length === 1, "first gateway call");

    const r2 = fakeRes();
    const second = handleSendMessage("c1", person, fakeReq({ content: "two" }), r2.res, deps(db));
    // The queued turn hears its ids right away, its row sits `pending`, and it
    // has not called the model.
    await until(() => r2.frames().some((f) => f.type === "start"), "second start");
    expect(r2.frames()[0]).toMatchObject({ user_message_id: "m3", assistant_message_id: "m4" });
    expect(rows.find((row) => row.id === "m4")!.status).toBe("pending");
    expect(gateway.calls).toHaveLength(1);

    say(0, "First reply.");
    finish(0);
    await first;
    await until(() => gateway.streams.length === 2, "second gateway call");
    const prompt = gateway.calls[1]!.messages.map((m) => [m.role, m.content]);
    expect(prompt).toContainEqual(["assistant", "First reply."]);
    expect(prompt.at(-1)).toEqual(["user", "two"]);
    say(1, "Second reply.");
    finish(1);
    await second;
    expect(rows.find((row) => row.id === "m4")).toMatchObject({
      status: "complete",
      content: "Second reply.",
    });
  });

  it("an interrupt while queued finalizes the row without calling the model", async () => {
    const { db, rows } = fakeDb();
    const first = handleSendMessage("c1", person, fakeReq({ content: "one" }), fakeRes().res, deps(db));
    await until(() => gateway.streams.length === 1, "first gateway call");
    const r2 = fakeRes();
    const second = handleSendMessage("c1", person, fakeReq({ content: "two" }), r2.res, deps(db));
    await until(() => r2.frames().some((f) => f.type === "start"), "second start");
    expect(cancels.signal("m4")).toBe(true);

    finish(0);
    await first;
    await second;
    expect(gateway.calls).toHaveLength(1);
    expect(rows.find((row) => row.id === "m4")!.status).toBe("interrupted");
    expect(r2.frames().at(-1)).toMatchObject({ type: "done", status: "interrupted" });
  });
});
