import { describe, expect, it } from "vitest";

import {
  costProxyBaseUrl,
  costTrackingEnabled,
  injectUsageAccounting,
  resolveUpstreamBase,
  upstreamTarget,
} from "./cost-proxy.js";
import type { AgentEnv } from "../env.js";

const env = (over: Partial<AgentEnv> = {}): AgentEnv =>
  ({
    LLM_PROVIDER: "openrouter",
    LLM_BASE_URL: undefined,
    OPENROUTER_COST_TRACKING: true,
    OPENROUTER_COST_PROXY_PORT: 18790,
    OPENROUTER_UPSTREAM_URL: undefined,
    ...over,
  }) as AgentEnv;

describe("costTrackingEnabled", () => {
  it("is on for OpenRouter with the flag set", () => {
    expect(costTrackingEnabled(env())).toBe(true);
  });

  it("is off for a non-OpenRouter provider (nothing to intercept)", () => {
    expect(costTrackingEnabled(env({ LLM_PROVIDER: "anthropic" }))).toBe(false);
    expect(costTrackingEnabled(env({ LLM_PROVIDER: "ollama" }))).toBe(false);
  });

  it("is off when the kill switch is set", () => {
    expect(costTrackingEnabled(env({ OPENROUTER_COST_TRACKING: false }))).toBe(false);
  });

  it("matches provider case-insensitively", () => {
    expect(costTrackingEnabled(env({ LLM_PROVIDER: "OpenRouter" }))).toBe(true);
  });
});

describe("costProxyBaseUrl", () => {
  it("is a loopback URL on the configured port", () => {
    expect(costProxyBaseUrl(env({ OPENROUTER_COST_PROXY_PORT: 9999 }))).toBe(
      "http://127.0.0.1:9999/api/v1",
    );
  });
});

describe("resolveUpstreamBase", () => {
  it("defaults to the public OpenRouter API", () => {
    expect(resolveUpstreamBase(env())).toBe("https://openrouter.ai/api/v1");
  });

  it("honors an explicit upstream override, then LLM_BASE_URL", () => {
    expect(
      resolveUpstreamBase(env({ OPENROUTER_UPSTREAM_URL: "https://gw.example/api/v1" })),
    ).toBe("https://gw.example/api/v1");
    expect(resolveUpstreamBase(env({ LLM_BASE_URL: "https://eu.openrouter.ai/api/v1/" }))).toBe(
      "https://eu.openrouter.ai/api/v1",
    );
  });
});

describe("upstreamTarget", () => {
  const base = "https://openrouter.ai/api/v1";

  it("maps a path openclaw composed WITH the /api/v1 prefix", () => {
    expect(upstreamTarget(base, "/api/v1/chat/completions")).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });

  it("maps a path openclaw composed WITHOUT the prefix", () => {
    expect(upstreamTarget(base, "/chat/completions")).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });

  it("strips a bare /v1 prefix too", () => {
    expect(upstreamTarget(base, "/v1/models")).toBe("https://openrouter.ai/api/v1/models");
  });

  it("preserves the query string", () => {
    expect(upstreamTarget(base, "/api/v1/generation?id=gen-abc")).toBe(
      "https://openrouter.ai/api/v1/generation?id=gen-abc",
    );
  });

  it("does not double-strip a path that merely contains v1 later", () => {
    expect(upstreamTarget(base, "/chat/v1beta/completions")).toBe(
      "https://openrouter.ai/api/v1/chat/v1beta/completions",
    );
  });
});

describe("injectUsageAccounting", () => {
  const parse = (buf: Buffer | null) => (buf ? JSON.parse(buf.toString("utf8")) : null);

  it("adds usage.include=true so OpenRouter returns per-request cost", () => {
    const out = parse(
      injectUsageAccounting(
        Buffer.from(JSON.stringify({ model: "qwen/qwen3.7-plus", messages: [], stream: true })),
      ),
    );
    expect(out.usage).toEqual({ include: true });
  });

  it("preserves every other field of the request untouched", () => {
    const body = {
      model: "qwen/qwen3.7-plus",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
    };
    const out = parse(injectUsageAccounting(Buffer.from(JSON.stringify(body))));
    expect(out).toEqual({ ...body, usage: { include: true } });
  });

  it("merges into an existing usage object rather than clobbering it", () => {
    const out = parse(
      injectUsageAccounting(Buffer.from(JSON.stringify({ messages: [], usage: { foo: 1 } }))),
    );
    expect(out.usage).toEqual({ foo: 1, include: true });
  });

  it("returns null for a body that is not a JSON object (forward unchanged)", () => {
    expect(injectUsageAccounting(Buffer.from("not json"))).toBeNull();
    expect(injectUsageAccounting(Buffer.from("[1,2,3]"))).toBeNull();
    expect(injectUsageAccounting(Buffer.from("\"a string\""))).toBeNull();
  });
});
