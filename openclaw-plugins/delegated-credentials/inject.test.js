import { describe, expect, it } from "vitest";

import { buildInjectedParams, isExecTool, parseCredentialsResponse } from "./inject.js";

describe("isExecTool", () => {
  it("true only for the host-exec tool(s)", () => {
    expect(isExecTool("exec")).toBe(true);
    expect(isExecTool("system_run")).toBe(true);
    expect(isExecTool("web_search")).toBe(false);
    expect(isExecTool(undefined)).toBe(false);
    expect(isExecTool(null)).toBe(false);
  });
});

describe("buildInjectedParams", () => {
  it("injects delegated creds into params.env (the headline case)", () => {
    const out = buildInjectedParams(
      { command: "python3 sportslink.py" },
      { SPORTSINC_API_KEY: "sekret" },
    );
    expect(out).toEqual({
      command: "python3 sportslink.py",
      env: { SPORTSINC_API_KEY: "sekret" },
    });
  });

  it("returns null when there are no creds (no-op → tool call unchanged)", () => {
    expect(buildInjectedParams({ command: "x" }, {})).toBeNull();
    expect(buildInjectedParams({ command: "x" }, null)).toBeNull();
    expect(buildInjectedParams({ command: "x" }, undefined)).toBeNull();
  });

  it("does not clobber an env the caller already set (explicit wins)", () => {
    const out = buildInjectedParams(
      { command: "x", env: { SPORTSINC_API_KEY: "explicit", OTHER: "1" } },
      { SPORTSINC_API_KEY: "delegated", NEW_KEY: "n" },
    );
    expect(out.env).toEqual({ SPORTSINC_API_KEY: "explicit", OTHER: "1", NEW_KEY: "n" });
  });

  it("does not mutate the input params", () => {
    const params = { command: "x" };
    buildInjectedParams(params, { SPORTSINC_API_KEY: "v" });
    expect(params).toEqual({ command: "x" });
  });

  it("drops non-string values and invalid env-var-name keys", () => {
    expect(buildInjectedParams({}, { GOOD: "v", "bad-key": "v", NUM: 3 })).toEqual({
      env: { GOOD: "v" },
    });
  });
});

describe("parseCredentialsResponse", () => {
  it("extracts the credentials map", () => {
    expect(parseCredentialsResponse({ credentials: { K: "v" } })).toEqual({ K: "v" });
  });

  it("returns {} for unexpected shapes", () => {
    expect(parseCredentialsResponse({})).toEqual({});
    expect(parseCredentialsResponse(null)).toEqual({});
    expect(parseCredentialsResponse({ credentials: [1] })).toEqual({});
    expect(parseCredentialsResponse("x")).toEqual({});
  });
});

describe("headline: delegated turn sees the var, the next non-delegated turn does not", () => {
  it("injects for a session with staged creds, no-op for one without", () => {
    // Model what the plugin does per exec call: look creds up by session key,
    // then build the injected params.
    const stagedBySession = {
      "a2a:conv-1": { SPORTSINC_API_KEY: "sekret-xyz" },
    };
    const lookup = (sessionKey) => stagedBySession[sessionKey] ?? {};

    // Turn 1 — a delegated A2A session running the skill via the exec tool.
    const delegated = buildInjectedParams(
      { command: "python3 sportslink.py get-for-a2a {}" },
      lookup("a2a:conv-1"),
    );
    expect(delegated.env.SPORTSINC_API_KEY).toBe("sekret-xyz");

    // Turn 2 — a different, non-delegated session: nothing staged → nothing injected.
    const plain = buildInjectedParams(
      { command: "python3 sportslink.py get-for-a2a {}" },
      lookup("webchat:conv-2"),
    );
    expect(plain).toBeNull();
  });
});
