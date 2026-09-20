import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import type { AgentEnv } from "../env.js";
import { HttpError } from "./auth.js";
import { DelegatedCredentialStore } from "./delegated-credentials.js";
import {
  handleDelegatedCredentialsLookup,
  handleToolCallIngest,
} from "./routes-internal.js";
import {
  ToolCallHub,
  type InsertToolCallRow,
  type ToolCallDB,
  type UpdateToolCallRow,
} from "./tool-telemetry.js";

const TOKEN = "gw-token-0123456789abcdef";

function makeEnv(): AgentEnv {
  return { OPENCLAW_GATEWAY_TOKEN: TOKEN } as AgentEnv;
}

function fakeReq(authorization?: string): IncomingMessage {
  return { headers: authorization ? { authorization } : {} } as unknown as IncomingMessage;
}

function fakeRes(): { res: ServerResponse; state: { status: number; body: string } } {
  const state = { status: 0, body: "" };
  const res = {
    writeHead(status: number): ServerResponse {
      state.status = status;
      return res as ServerResponse;
    },
    end(payload?: string): void {
      if (payload) state.body = payload;
    },
  } as unknown as ServerResponse;
  return { res, state };
}

function lookupUrl(sessionKey: string): URL {
  return new URL(
    `http://localhost/internal/delegated-credentials?session_key=${encodeURIComponent(sessionKey)}`,
  );
}

/** No `session_key` param — the exec-shim caller shape (resolved via currentSingle). */
function currentUrl(): URL {
  return new URL("http://localhost/internal/delegated-credentials");
}

describe("handleDelegatedCredentialsLookup", () => {
  it("returns the staged creds for a session key (gateway-token authed)", () => {
    const store = new DelegatedCredentialStore();
    store.set("a2a:conv-1", { SPORTSINC_API_KEY: "sekret" });
    const { res, state } = fakeRes();

    handleDelegatedCredentialsLookup(
      lookupUrl("a2a:conv-1"),
      fakeReq(`Bearer ${TOKEN}`),
      res,
      makeEnv(),
      store,
    );

    expect(state.status).toBe(200);
    expect(JSON.parse(state.body)).toEqual({ credentials: { SPORTSINC_API_KEY: "sekret" } });
  });

  it("returns empty credentials for an unknown session", () => {
    const { res, state } = fakeRes();
    handleDelegatedCredentialsLookup(
      lookupUrl("a2a:unknown"),
      fakeReq(`Bearer ${TOKEN}`),
      res,
      makeEnv(),
      new DelegatedCredentialStore(),
    );
    expect(JSON.parse(state.body)).toEqual({ credentials: {} });
  });

  it("rejects a missing or incorrect gateway token", () => {
    const store = new DelegatedCredentialStore();
    store.set("a2a:conv-1", { SPORTSINC_API_KEY: "v" });

    expect(() =>
      handleDelegatedCredentialsLookup(
        lookupUrl("a2a:conv-1"),
        fakeReq(),
        fakeRes().res,
        makeEnv(),
        store,
      ),
    ).toThrow(HttpError);

    expect(() =>
      handleDelegatedCredentialsLookup(
        lookupUrl("a2a:conv-1"),
        fakeReq("Bearer wrong-token"),
        fakeRes().res,
        makeEnv(),
        store,
      ),
    ).toThrow(HttpError);
  });

  // The exec-shim (docker/knox-python3-shim.py) hits this route WITHOUT a
  // session_key, because openclaw exposes no session key to a skill's exec
  // subprocess. The route then resolves the single currently-live turn.
  it("no session_key → returns the single live turn's creds (exec-shim caller shape)", () => {
    const store = new DelegatedCredentialStore();
    store.set("a2a:conv-1", { SPORTSINC_API_KEY: "sekret" });
    const { res, state } = fakeRes();

    handleDelegatedCredentialsLookup(currentUrl(), fakeReq(`Bearer ${TOKEN}`), res, makeEnv(), store);

    expect(state.status).toBe(200);
    expect(JSON.parse(state.body)).toEqual({ credentials: { SPORTSINC_API_KEY: "sekret" } });
  });

  it("no session_key + two concurrent turns → {} (fail-closed, never guess the caller)", () => {
    const store = new DelegatedCredentialStore();
    store.set("a2a:conv-A", { SPORTSINC_API_KEY: "aaa" });
    store.set("a2a:conv-B", { SPORTSINC_API_KEY: "bbb" });
    const { res, state } = fakeRes();

    handleDelegatedCredentialsLookup(currentUrl(), fakeReq(`Bearer ${TOKEN}`), res, makeEnv(), store);

    expect(JSON.parse(state.body)).toEqual({ credentials: {} });
  });

  it("no session_key + nothing staged → {} (skill surfaces its own auth error)", () => {
    const { res, state } = fakeRes();
    handleDelegatedCredentialsLookup(
      currentUrl(),
      fakeReq(`Bearer ${TOKEN}`),
      res,
      makeEnv(),
      new DelegatedCredentialStore(),
    );
    expect(JSON.parse(state.body)).toEqual({ credentials: {} });
  });

  it("still requires the gateway token even without a session_key", () => {
    const store = new DelegatedCredentialStore();
    store.set("a2a:conv-1", { SPORTSINC_API_KEY: "v" });
    expect(() =>
      handleDelegatedCredentialsLookup(currentUrl(), fakeReq(), fakeRes().res, makeEnv(), store),
    ).toThrow(HttpError);
  });
});

/** A POST req whose body is `obj` (JSON), plus the gateway auth header. */
function jsonReq(obj: unknown, authorization = `Bearer ${TOKEN}`): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(obj))]) as unknown as IncomingMessage;
  stream.headers = authorization ? { authorization } : {};
  return stream;
}

function fakeHub(enabled = true) {
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
  const hub = new ToolCallHub({ db, orgId: "org1", agentUid: "agent1", enabled });
  return { hub, inserts, updates };
}

describe("handleToolCallIngest", () => {
  it("rejects a missing/incorrect gateway token", async () => {
    const { hub } = fakeHub();
    await expect(
      handleToolCallIngest(jsonReq({ phase: "start" }, ""), fakeRes().res, makeEnv(), hub),
    ).rejects.toThrow(HttpError);
  });

  it("no-ops (recorded:false) when tracking is disabled", async () => {
    const { hub, inserts } = fakeHub(false);
    const { res, state } = fakeRes();
    await handleToolCallIngest(jsonReq({ phase: "start", tool_name: "exec" }), res, makeEnv(), hub);
    expect(state.status).toBe(200);
    expect(JSON.parse(state.body)).toEqual({ ok: true, recorded: false });
    expect(inserts).toHaveLength(0);
  });

  it("records a start event into the hub", async () => {
    const { hub, inserts } = fakeHub();
    const { res, state } = fakeRes();
    await handleToolCallIngest(
      jsonReq({
        phase: "start",
        session_key: "webchat:conv-1",
        tool_name: "odoo_production__sales_get_order",
        server: "odoo_production",
        args_preview: { id: 5 },
      }),
      res,
      makeEnv(),
      hub,
    );
    expect(state.status).toBe(200);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      conversationId: "conv-1",
      toolName: "odoo_production__sales_get_order",
      server: "odoo_production",
      argsPreview: { id: 5 },
    });
  });

  it("records an end event as an enrichment update", async () => {
    const { hub, updates } = fakeHub();
    // The message/task path opens the turn (begin) before any tool call arrives;
    // correlation of the end event to its row depends on that turn context.
    hub.begin("webchat:c", { conversationId: "c", assistantMessageId: "m", taskId: null });
    // Open a call first so there is something to close.
    await handleToolCallIngest(
      jsonReq({ phase: "start", session_key: "webchat:c", tool_name: "exec" }),
      fakeRes().res,
      makeEnv(),
      hub,
    );
    await handleToolCallIngest(
      jsonReq({ phase: "end", session_key: "webchat:c", status: "error", duration_ms: 42 }),
      fakeRes().res,
      makeEnv(),
      hub,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toMatchObject({ status: "error", durationMs: 42 });
  });

  it("ignores an unknown phase without inserting", async () => {
    const { hub, inserts } = fakeHub();
    const { res, state } = fakeRes();
    await handleToolCallIngest(jsonReq({ phase: "wat" }), res, makeEnv(), hub);
    expect(JSON.parse(state.body)).toEqual({ ok: true, recorded: false });
    expect(inserts).toHaveLength(0);
  });
});
