import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hookResult,
  isPlatformTool,
  isVoiceSessionKey,
  PLUGIN_TOKEN_SLOT,
  postShim,
  SESSION_STAMP_PARAM,
  stampSession,
  UNCHECKED_REASON,
} from "./policy.js";

describe("knox-session-policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process[PLUGIN_TOKEN_SLOT];
  });

  it("blocks unless the shim says the call may run (fail-closed)", () => {
    expect(hookResult({ allow: true })).toBeUndefined();
    expect(hookResult({ allow: false, reason: "no exec here" })).toEqual({ block: true, blockReason: "no exec here" });
    expect(hookResult(null)).toEqual({ block: true, blockReason: UNCHECKED_REASON });
    expect(hookResult({})).toEqual({ block: true, blockReason: UNCHECKED_REASON });
    expect(hookResult({ allow: "yes" })).toEqual({ block: true, blockReason: UNCHECKED_REASON });
    // Only with the rules switched off does no answer let the call through.
    expect(hookResult(null, { failOpen: true })).toBeUndefined();
    expect(hookResult({ allow: false, reason: "r" }, { failOpen: true })).toEqual({ block: true, blockReason: "r" });
  });

  it("stamps the shim's ticket in place, overwriting what the model wrote", () => {
    const params = { limit: 5, [SESSION_STAMP_PARAM]: "webchat:someone-elses" };
    expect(stampSession(params, "kst_abc")).toBe(true);
    expect(params).toEqual({ limit: 5, [SESSION_STAMP_PARAM]: "kst_abc" });
    // No session key: a stamp the model wrote is removed, not forwarded.
    const p2 = { [SESSION_STAMP_PARAM]: "webchat:x" };
    expect(stampSession(p2, null)).toBe(false);
    expect(p2).toEqual({});
    expect(stampSession(null, "webchat:mine")).toBe(false);
  });

  it("recognizes platform tools and phone sessions", () => {
    expect(isPlatformTool("knoxville_platform__list_my_tasks")).toBe(true);
    expect(isPlatformTool("odoo__x")).toBe(false);
    expect(isVoiceSessionKey("agent:main:voice:19015550100")).toBe(true);
    expect(isVoiceSessionKey("webchat:c")).toBe(false);
  });

  it("asks the shim over loopback with the plugin token; any failure is no answer", async () => {
    // The token lives in the gateway process's slot, never in its environment.
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "not-this-one");
    process[PLUGIN_TOKEN_SLOT] = "gw";
    vi.stubEnv("AGENT_HTTP_PORT", "9999");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ allow: true }), { status: 200 }));
    expect(await postShim("/internal/tool-policy", { a: 1 }, { fetchImpl })).toEqual({ allow: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:9999/internal/tool-policy");
    expect(init.headers.Authorization).toBe("Bearer gw");
    expect(await postShim("/x", {}, { fetchImpl: async () => new Response("", { status: 500 }) })).toBeNull();
    expect(
      await postShim("/x", {}, {
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    ).toBeNull();
    // No token in the slot: no request at all (and the hook then blocks).
    delete process[PLUGIN_TOKEN_SLOT];
    fetchImpl.mockClear();
    expect(await postShim("/x", {}, { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
