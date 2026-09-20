import { describe, expect, it } from "vitest";

import { count, redactArgs, serverFromToolName } from "./redact.js";

describe("redactArgs — credential-shaped keys", () => {
  it("redacts values under sensitive key names, keeps benign ones", () => {
    const out = redactArgs({
      query: "SELECT 1",
      api_key: "sk-live-super-secret",
      apiKey: "another",
      password: "hunter2",
      refresh_token: "rt_xyz",
      clientSecret: "cs_xyz",
      authorization: "Bearer abc",
      limit: 25,
    });
    expect(out.query).toBe("SELECT 1");
    expect(out.limit).toBe(25);
    for (const k of [
      "api_key",
      "apiKey",
      "password",
      "refresh_token",
      "clientSecret",
      "authorization",
    ]) {
      expect(out[k], k).toBe("[redacted]");
    }
  });

  it("redacts nested sensitive keys, keeps benign siblings", () => {
    const out = redactArgs({ auth: { token: "t" }, cfg: { db_password: "p", host: "h" } });
    // `auth` is itself a sensitive key name → redacted wholesale, never walked
    // into (so the nested token can't leak).
    expect(out.auth).toBe("[redacted]");
    // A benign-named object IS walked: its sensitive child is redacted, its
    // benign child kept.
    expect(out.cfg.host).toBe("h");
    expect(out.cfg.db_password).toBe("[redacted]");
  });
});

describe("redactArgs — the exec env bag (brokered credentials)", () => {
  it("summarizes env to key NAMES only, never values", () => {
    const out = redactArgs({
      command: "python3 run.py",
      env: { SPORTSINC_API_KEY: "secret-value", SANMAR_TOKEN: "another-secret" },
    });
    expect(out.command).toBe("python3 run.py");
    const env = String(out.env);
    expect(env).toContain("SPORTSINC_API_KEY");
    expect(env).toContain("SANMAR_TOKEN");
    expect(env).not.toContain("secret-value");
    expect(env).not.toContain("another-secret");
    expect(env).toMatch(/^\[redacted: 2 keys/);
  });

  it("summarizes a headers bag the same way", () => {
    const out = redactArgs({ url: "https://x", headers: { Authorization: "Bearer zzz" } });
    expect(out.url).toBe("https://x");
    expect(String(out.headers)).not.toContain("zzz");
    expect(String(out.headers)).toContain("Authorization");
  });
});

describe("redactArgs — bounds", () => {
  it("truncates long strings", () => {
    const out = redactArgs({ blob: "x".repeat(1000) });
    expect(out.blob.length).toBeLessThan(1000);
    expect(out.blob).toMatch(/…\(\+744 chars\)$/);
  });

  it("caps array length with a marker", () => {
    const out = redactArgs({ items: Array.from({ length: 50 }, (_, i) => i) });
    expect(out.items.length).toBe(21); // 20 kept + 1 marker
    expect(out.items[20]).toBe("…(+30 items)");
  });

  it("stops walking past the depth cap", () => {
    const deep = { a: { b: { c: { d: { e: "too deep" } } } } };
    const out = redactArgs(deep);
    // Serializes without throwing and does not contain the deepest value.
    expect(JSON.stringify(out)).not.toContain("too deep");
  });

  it("falls back to a shape summary for an oversized payload", () => {
    const big = {};
    for (let i = 0; i < 40; i++) big[`k${i}`] = "y".repeat(250);
    const out = redactArgs(big);
    // Either the per-field caps kept it, or the final guard replaced it — both
    // are bounded and serializable.
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(JSON.stringify(out).length).toBeLessThan(8000);
  });

  it("handles circular structures without throwing", () => {
    const a = { name: "x" };
    a.self = a;
    const out = redactArgs(a);
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});

describe("redactArgs — shapes", () => {
  it("returns null for null/undefined", () => {
    expect(redactArgs(null)).toBeNull();
    expect(redactArgs(undefined)).toBeNull();
  });

  it("wraps a scalar top-level params", () => {
    expect(redactArgs("hi")).toEqual({ value: "hi" });
    expect(redactArgs(42)).toEqual({ value: 42 });
  });

  it("preserves a benign array top-level", () => {
    expect(redactArgs([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe("serverFromToolName", () => {
  it("extracts the MCP server prefix", () => {
    expect(serverFromToolName("knoxville_platform__get_my_bundle")).toBe(
      "knoxville_platform",
    );
    expect(serverFromToolName("odoo_production__sales_get_order")).toBe(
      "odoo_production",
    );
    expect(serverFromToolName("server.tool")).toBe("server");
    expect(serverFromToolName("server:tool")).toBe("server");
  });

  it("returns null for a built-in tool with no separator", () => {
    expect(serverFromToolName("exec")).toBeNull();
    expect(serverFromToolName("bash")).toBeNull();
    expect(serverFromToolName("")).toBeNull();
    expect(serverFromToolName(null)).toBeNull();
  });
});

describe("count", () => {
  it("coerces to a non-negative integer or null", () => {
    expect(count(12.7)).toBe(12);
    expect(count(0)).toBe(0);
    expect(count(-1)).toBeNull();
    expect(count("5")).toBeNull();
    expect(count(undefined)).toBeNull();
    expect(count(NaN)).toBeNull();
  });
});
