import { afterEach, describe, expect, it, vi } from "vitest";

import { BundleClient, extractDelegatedCredentials } from "./client.js";

describe("extractDelegatedCredentials", () => {
  it("pulls string values under valid env-var-name keys", () => {
    expect(
      extractDelegatedCredentials({ credentials: { SPORTSINC_API_KEY: "sekret-123" } }),
    ).toEqual({ SPORTSINC_API_KEY: "sekret-123" });
  });

  it("empty / missing credentials → {}", () => {
    expect(extractDelegatedCredentials({ credentials: {} })).toEqual({});
    expect(extractDelegatedCredentials({})).toEqual({});
    expect(extractDelegatedCredentials(null)).toEqual({});
    expect(extractDelegatedCredentials(undefined)).toEqual({});
  });

  it("drops non-string values and invalid env-var-name keys", () => {
    expect(
      extractDelegatedCredentials({
        credentials: {
          GOOD_KEY: "v",
          NUMERIC: 5,
          "bad-key": "v",
          "1STARTS_NUM": "v",
          NESTED: { a: 1 },
        },
      }),
    ).toEqual({ GOOD_KEY: "v" });
  });

  it("non-object credentials shape → {}", () => {
    expect(extractDelegatedCredentials({ credentials: [1, 2] })).toEqual({});
    expect(extractDelegatedCredentials({ credentials: "x" })).toEqual({});
  });
});

describe("BundleClient.fetchDelegatedCredentials", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the credentials map on a successful tool call", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { structuredContent: { credentials: { SPORTSINC_API_KEY: "v" } } },
        }),
        { status: 200 },
      ),
    );
    const client = new BundleClient({ url: "https://mcp.example/api", token: "t" });
    await expect(client.fetchDelegatedCredentials("conv-1")).resolves.toEqual({
      SPORTSINC_API_KEY: "v",
    });
  });

  it("returns {} and never throws when the MCP call rejects (broker hiccup)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new BundleClient({ url: "https://mcp.example/api", token: "t", timeoutMs: 500 });
    await expect(client.fetchDelegatedCredentials("conv-1")).resolves.toEqual({});
  });

  it("returns {} when the tool result reports isError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { isError: true, content: [{ type: "text", text: "not shared" }] },
        }),
        { status: 200 },
      ),
    );
    const client = new BundleClient({ url: "https://mcp.example/api", token: "t" });
    await expect(client.fetchDelegatedCredentials("conv-1")).resolves.toEqual({});
  });

  it("never writes the secret value to the logs (only key names)", async () => {
    const secret = "sk-delegated-supersecret-do-not-log";
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c: unknown): boolean => {
      writes.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((c: unknown): boolean => {
      writes.push(String(c));
      return true;
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { structuredContent: { credentials: { SPORTSINC_API_KEY: secret } } },
        }),
        { status: 200 },
      ),
    );

    const client = new BundleClient({ url: "https://mcp.example/api", token: "t" });
    const out = await client.fetchDelegatedCredentials("conv-1");

    expect(out).toEqual({ SPORTSINC_API_KEY: secret });
    const logged = writes.join("");
    expect(logged).not.toContain(secret);
    // The key NAME is fine to log (not a secret) and useful for audit.
    expect(logged).toContain("SPORTSINC_API_KEY");
  });
});
