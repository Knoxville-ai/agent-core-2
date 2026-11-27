import { describe, expect, it } from "vitest";

import {
  gatewayAuthToken,
  isPluginLoopbackAuth,
  pluginLoopbackToken,
  PLUGIN_TOKEN_SLOT,
} from "./gateway-auth.js";
import { receivePluginToken } from "./preload-options.js";

describe("gatewayAuthToken", () => {
  const env = { OPENCLAW_GATEWAY_TOKEN: "console-gateway-token-0123456789" };

  it("is stable for one console token and differs from it", () => {
    expect(gatewayAuthToken(env)).toBe(gatewayAuthToken({ ...env }));
    expect(gatewayAuthToken(env)).not.toBe(env.OPENCLAW_GATEWAY_TOKEN);
    expect(gatewayAuthToken(env)).not.toContain(env.OPENCLAW_GATEWAY_TOKEN);
  });

  it("changes when the console token rotates", () => {
    expect(gatewayAuthToken({ OPENCLAW_GATEWAY_TOKEN: "another-console-token-xyz" })).not.toBe(
      gatewayAuthToken(env),
    );
  });
});

describe("plugin loopback token", () => {
  it("is random, long, and constant for the process", () => {
    expect(pluginLoopbackToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pluginLoopbackToken()).toBe(pluginLoopbackToken());
  });

  it("accepts only `Bearer <token>`", () => {
    expect(isPluginLoopbackAuth(`Bearer ${pluginLoopbackToken()}`)).toBe(true);
    expect(isPluginLoopbackAuth(pluginLoopbackToken())).toBe(false);
    expect(isPluginLoopbackAuth("Bearer ")).toBe(false);
    expect(isPluginLoopbackAuth("Bearer nope")).toBe(false);
    expect(isPluginLoopbackAuth(undefined)).toBe(false);
  });
});

describe("receivePluginToken (gateway preload side)", () => {
  function io(env: NodeJS.ProcessEnv, read: (fd: number) => string = () => "tok-123\n") {
    const closed: number[] = [];
    const target = {};
    return {
      closed,
      target,
      io: {
        env,
        fdEnv: "KNOX_PLUGIN_TOKEN_FD",
        slot: PLUGIN_TOKEN_SLOT,
        target,
        read,
        close: (fd: number) => closed.push(fd),
      },
    };
  }

  it("reads the token from the fd into a hidden, read-only slot and drops the fd variable", () => {
    const env: NodeJS.ProcessEnv = { KNOX_PLUGIN_TOKEN_FD: "3", OTHER: "x" };
    const t = io(env);
    expect(receivePluginToken(t.io)).toBe(true);
    const slot = Symbol.for(PLUGIN_TOKEN_SLOT);
    expect((t.target as Record<symbol, unknown>)[slot]).toBe("tok-123");
    expect(Object.keys(t.target)).toEqual([]);
    expect(JSON.stringify(t.target)).toBe("{}");
    expect(() => {
      "use strict";
      (t.target as Record<symbol, unknown>)[slot] = "other";
    }).toThrow();
    expect(t.closed).toEqual([3]);
    expect(env).toEqual({ OTHER: "x" });
    // Never lands in the environment.
    expect(Object.values(env)).not.toContain("tok-123");
  });

  it("does nothing without the fd variable, or for a std stream fd", () => {
    expect(receivePluginToken(io({}).io)).toBe(false);
    const t = io({ KNOX_PLUGIN_TOKEN_FD: "1" });
    expect(receivePluginToken(t.io)).toBe(false);
    expect(t.closed).toEqual([]);
  });

  it("never throws on a read failure, and still closes the fd", () => {
    const t = io({ KNOX_PLUGIN_TOKEN_FD: "3" }, () => {
      throw new Error("EBADF");
    });
    expect(receivePluginToken(t.io)).toBe(false);
    expect(t.closed).toEqual([3]);
  });
});
