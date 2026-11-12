import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  costProxyBaseUrl,
  costTrackingEnabled,
  prepareChatBody,
  resolveUpstreamBase,
  startCostProxy,
  upstreamTarget,
} from "./cost-proxy.js";
import type { UsageAccumulator } from "./usage-telemetry.js";
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

describe("prepareChatBody", () => {
  const run = (obj: unknown) => {
    const { body, sessionCacheKey, requestKeys } = prepareChatBody(
      Buffer.from(JSON.stringify(obj)),
    );
    return { parsed: JSON.parse(body.toString("utf8")), sessionCacheKey, requestKeys };
  };

  it("adds usage.include=true so OpenRouter returns per-request cost", () => {
    const { parsed } = run({ model: "qwen/qwen3.7-plus", messages: [], stream: true });
    expect(parsed.usage).toEqual({ include: true });
  });

  it("extracts prompt_cache_key as the session the cost is attributed to", () => {
    const { sessionCacheKey } = run({ messages: [], prompt_cache_key: "task:abc-123" });
    expect(sessionCacheKey).toBe("task:abc-123");
  });

  it("falls back to the `user` field when prompt_cache_key is absent", () => {
    const { sessionCacheKey } = run({ messages: [], user: "task:xyz" });
    expect(sessionCacheKey).toBe("task:xyz");
  });

  it("returns a null session key when neither prompt_cache_key nor user is set", () => {
    expect(run({ messages: [] }).sessionCacheKey).toBeNull();
  });

  it("reports the request's top-level field names (diagnostic)", () => {
    const { requestKeys } = run({ model: "m", messages: [], stream: true });
    expect(requestKeys).toEqual(expect.arrayContaining(["model", "messages", "stream"]));
  });

  it("preserves every other field of the request untouched", () => {
    const body = {
      model: "qwen/qwen3.7-plus",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      prompt_cache_key: "webchat:conv-1",
    };
    const { parsed } = run(body);
    expect(parsed).toEqual({ ...body, usage: { include: true } });
  });

  it("merges into an existing usage object rather than clobbering it", () => {
    const { parsed } = run({ messages: [], usage: { foo: 1 } });
    expect(parsed.usage).toEqual({ foo: 1, include: true });
  });

  it("forwards a non-JSON-object body UNCHANGED with a null session key", () => {
    for (const raw of ["not json", "[1,2,3]", '"a string"']) {
      const { body, sessionCacheKey, outputLowered } = prepareChatBody(Buffer.from(raw), 32_000);
      expect(body.toString("utf8")).toBe(raw); // untouched
      expect(sessionCacheKey).toBeNull();
      expect(outputLowered).toBeNull();
    }
  });

  describe("output limit", () => {
    const send = (obj: Record<string, unknown>, cap?: number) => {
      const { body, outputLowered } = prepareChatBody(Buffer.from(JSON.stringify(obj)), cap);
      return { parsed: JSON.parse(body.toString("utf8")) as Record<string, unknown>, outputLowered };
    };

    it("lowers a max_completion_tokens above the cap and reports it", () => {
      // The call that failed: GLM's listed 943,718 left ~105k of a 1M window.
      const { parsed, outputLowered } = send(
        { model: "z-ai/glm-5.2", messages: [], max_completion_tokens: 943_718 },
        32_000,
      );
      expect(parsed.max_completion_tokens).toBe(32_000);
      expect(outputLowered).toEqual({ model: "z-ai/glm-5.2", from: 943_718, to: 32_000 });
    });

    it("lowers max_tokens the same way", () => {
      const { parsed, outputLowered } = send({ model: "m", messages: [], max_tokens: 200_000 }, 32_000);
      expect(parsed.max_tokens).toBe(32_000);
      expect(outputLowered).toEqual({ model: "m", from: 200_000, to: 32_000 });
    });

    it("leaves a limit at or below the cap alone — it never raises one", () => {
      for (const limit of [8_192, 32_000]) {
        const { parsed, outputLowered } = send({ messages: [], max_tokens: limit }, 32_000);
        expect(parsed.max_tokens).toBe(limit);
        expect(outputLowered).toBeNull();
      }
    });

    it("never adds a limit to a request that has none", () => {
      const { parsed, outputLowered } = send({ messages: [] }, 32_000);
      expect(parsed).not.toHaveProperty("max_tokens");
      expect(parsed).not.toHaveProperty("max_completion_tokens");
      expect(outputLowered).toBeNull();
    });

    it("leaves the limit alone without a cap, or when it isn't a number", () => {
      expect(send({ messages: [], max_tokens: 943_718 }).parsed.max_tokens).toBe(943_718);
      expect(send({ messages: [], max_tokens: "943718" }, 32_000).parsed.max_tokens).toBe("943718");
    });

    it("changes nothing else about the request", () => {
      const request = {
        model: "z-ai/glm-5.2",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        prompt_cache_key: "webchat:conv-1",
        reasoning: { effort: "medium" },
        max_completion_tokens: 943_718,
      };
      expect(send(request, 32_000).parsed).toEqual({
        ...request,
        max_completion_tokens: 32_000,
        usage: { include: true },
      });
    });
  });
});

describe("startCostProxy", () => {
  const freePort = async (): Promise<number> => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  };

  /** POST through the proxy with node:http (no proxy env, no fetch quirks). */
  const post = (url: string, body: string) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = httpRequest(url, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end(body);
    });

  it("forwards a chat call with its output limit lowered to OPENROUTER_MAX_OUTPUT_TOKENS", async () => {
    const received: Array<Record<string, unknown>> = [];
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "gen-1", choices: [] }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const usage = { enableCostCorrelation() {}, recordCost() {} } as unknown as UsageAccumulator;
    const handle = await startCostProxy(
      env({
        OPENROUTER_COST_PROXY_PORT: await freePort(),
        OPENROUTER_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}/api/v1`,
        OPENROUTER_MAX_OUTPUT_TOKENS: 32_000,
      }),
      usage,
    );
    try {
      expect(handle).not.toBeNull();
      const res = await post(
        `${handle!.baseUrl}/chat/completions`,
        JSON.stringify({ model: "z-ai/glm-5.2", messages: [], max_completion_tokens: 943_718 }),
      );
      expect(res.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        model: "z-ai/glm-5.2",
        max_completion_tokens: 32_000,
        usage: { include: true },
      });
    } finally {
      await handle?.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
