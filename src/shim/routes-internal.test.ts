import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import type { AgentEnv } from "../env.js";
import { HttpError } from "./auth.js";
import { DelegatedCredentialStore } from "./delegated-credentials.js";
import { handleDelegatedCredentialsLookup } from "./routes-internal.js";

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
});
