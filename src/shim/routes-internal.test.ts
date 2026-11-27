import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import type { AgentEnv } from "../env.js";
import { gatewayAuthToken, pluginLoopbackToken } from "../openclaw/gateway-auth.js";
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

/** The console's gateway token: valid for /files and /skills, never here. */
const GATEWAY_TOKEN = "gw-token-0123456789abcdef";
/** The plugin loopback token the knox plugins present. */
const TOKEN = pluginLoopbackToken();

function makeEnv(): AgentEnv {
  return { OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN } as AgentEnv;
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

/** No `session_key` param. */
function currentUrl(): URL {
  return new URL("http://localhost/internal/delegated-credentials");
}

describe("handleDelegatedCredentialsLookup", () => {
  it("returns the staged creds for a session key (plugin-token authed)", () => {
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

  it("only ever returns the named session's creds, with others staged alongside", () => {
    const store = new DelegatedCredentialStore();
    store.set("task:A", { SPORTSINC_API_KEY: "aaa" });
    store.set("task:B", { SPORTSINC_API_KEY: "bbb" });
    const { res, state } = fakeRes();
    handleDelegatedCredentialsLookup(lookupUrl("task:B"), fakeReq(`Bearer ${TOKEN}`), res, makeEnv(), store);
    expect(JSON.parse(state.body)).toEqual({ credentials: { SPORTSINC_API_KEY: "bbb" } });
  });

  function status(fn: () => void): number {
    try {
      fn();
    } catch (err) {
      if (err instanceof HttpError) return err.status;
      throw err;
    }
    return 200;
  }

  it("401s without the plugin loopback token: none, wrong, the console's gateway token, or openclaw.json's", () => {
    const store = new DelegatedCredentialStore();
    store.set("a2a:conv-1", { SPORTSINC_API_KEY: "v" });
    for (const auth of [
      undefined,
      "Bearer wrong-token",
      `Bearer ${GATEWAY_TOKEN}`,
      `Bearer ${gatewayAuthToken(makeEnv())}`,
      TOKEN, // not a Bearer header
    ]) {
      expect(
        status(() =>
          handleDelegatedCredentialsLookup(
            lookupUrl("a2a:conv-1"),
            fakeReq(auth),
            fakeRes().res,
            makeEnv(),
            store,
          ),
        ),
        String(auth),
      ).toBe(401);
    }
  });

  it("refuses a lookup without a session key, even with one turn live", () => {
    const store = new DelegatedCredentialStore();
    store.set("a2a:conv-1", { SPORTSINC_API_KEY: "sekret" });
    const { res, state } = fakeRes();
    expect(
      status(() =>
        handleDelegatedCredentialsLookup(currentUrl(), fakeReq(`Bearer ${TOKEN}`), res, makeEnv(), store),
      ),
    ).toBe(400);
    expect(state.body).toBe("");
    // And without the token it is a 401 first.
    expect(
      status(() =>
        handleDelegatedCredentialsLookup(currentUrl(), fakeReq(`Bearer ${GATEWAY_TOKEN}`), fakeRes().res, makeEnv(), store),
      ),
    ).toBe(401);
  });
});

/** A POST req whose body is `obj` (JSON), plus the plugin loopback auth header. */
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
  it("rejects a missing/incorrect loopback token, including the console's gateway token", async () => {
    const { hub } = fakeHub();
    await expect(
      handleToolCallIngest(jsonReq({ phase: "start" }, ""), fakeRes().res, makeEnv(), hub),
    ).rejects.toThrow(HttpError);
    await expect(
      handleToolCallIngest(
        jsonReq({ phase: "start" }, `Bearer ${GATEWAY_TOKEN}`),
        fakeRes().res,
        makeEnv(),
        hub,
      ),
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
      jsonReq({
        phase: "end",
        session_key: "webchat:c",
        status: "error",
        error: "kaboom",
        duration_ms: 42,
      }),
      fakeRes().res,
      makeEnv(),
      hub,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toMatchObject({ status: "error", error: "kaboom", durationMs: 42 });
  });

  it("ignores an unknown phase without inserting", async () => {
    const { hub, inserts } = fakeHub();
    const { res, state } = fakeRes();
    await handleToolCallIngest(jsonReq({ phase: "wat" }), res, makeEnv(), hub);
    expect(JSON.parse(state.body)).toEqual({ ok: true, recorded: false });
    expect(inserts).toHaveLength(0);
  });
});
