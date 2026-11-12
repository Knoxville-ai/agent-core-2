import { describe, expect, it, vi } from "vitest";

import type { AgentEnv } from "../env.js";
import {
  fetchOpenRouterCatalog,
  listedMaxOutputTokens,
  OPENROUTER_MODELS_URL,
  outputCapsFor,
} from "./openrouter-output-caps.js";

const env = (over: Partial<AgentEnv> = {}): AgentEnv =>
  ({ LLM_PROVIDER: "openrouter", LLM_MODEL: "z-ai/glm-5.2", ...over }) as AgentEnv;

/** Catalog entries shaped like OpenRouter's /models `data`. */
const glm = {
  id: "z-ai/glm-5.2",
  context_length: 1_048_576,
  top_provider: { context_length: 1_048_576, max_completion_tokens: 943_718 },
};
const sonnet = {
  id: "anthropic/claude-sonnet-5",
  context_length: 1_000_000,
  top_provider: { context_length: 1_000_000, max_completion_tokens: 64_000 },
};
const unlisted = { id: "acme/no-limit", context_length: 131_072, top_provider: { context_length: 131_072 } };

describe("listedMaxOutputTokens", () => {
  it("reads top_provider.max_completion_tokens, as openclaw does", () => {
    expect(listedMaxOutputTokens(glm)).toBe(943_718);
  });

  it("falls back to max_completion_tokens, then max_output_tokens", () => {
    expect(listedMaxOutputTokens({ top_provider: {}, max_completion_tokens: 50_000 })).toBe(50_000);
    expect(listedMaxOutputTokens({ top_provider: { max_completion_tokens: null }, max_output_tokens: 40_000 })).toBe(
      40_000,
    );
  });

  it("is undefined when nothing usable is listed (openclaw then uses 8192)", () => {
    expect(listedMaxOutputTokens(unlisted)).toBeUndefined();
    expect(listedMaxOutputTokens({ top_provider: { max_completion_tokens: 0 } })).toBeUndefined();
    expect(listedMaxOutputTokens({ top_provider: { max_completion_tokens: "943718" } })).toBeUndefined();
    expect(listedMaxOutputTokens(null)).toBeUndefined();
    expect(listedMaxOutputTokens("z-ai/glm-5.2")).toBeUndefined();
  });

  it("takes the first SET value, like openclaw's ?? chain, even when it isn't usable", () => {
    // openclaw would use the 0 (and send no limit); a cap must not second-guess it.
    expect(listedMaxOutputTokens({ top_provider: { max_completion_tokens: 0 }, max_completion_tokens: 99_999 })).toBe(
      undefined,
    );
  });
});

describe("outputCapsFor", () => {
  const catalog = [glm, sonnet, unlisted, { id: "z-ai/glm-5.3", top_provider: { max_completion_tokens: 943_718 } }];

  it("caps only the models whose listing exceeds the cap", () => {
    // Sonnet's 64k is above a 32k cap too; the model with no listing keeps openclaw's own value.
    expect(
      outputCapsFor(catalog, ["z-ai/glm-5.2", "anthropic/claude-sonnet-5", "acme/no-limit"], 32_000),
    ).toEqual({ "z-ai/glm-5.2": 32_000, "anthropic/claude-sonnet-5": 32_000 });
  });

  it("never caps a listing at or below the cap (that would raise nothing, but must not be written)", () => {
    expect(outputCapsFor(catalog, ["anthropic/claude-sonnet-5"], 64_000)).toEqual({});
    expect(outputCapsFor(catalog, ["anthropic/claude-sonnet-5"], 100_000)).toEqual({});
  });

  it("ignores catalog models the agent doesn't run", () => {
    expect(outputCapsFor(catalog, ["z-ai/glm-5.3"], 32_000)).toEqual({ "z-ai/glm-5.3": 32_000 });
  });

  it("has no caps without a catalog or without model ids", () => {
    expect(outputCapsFor(null, ["z-ai/glm-5.2"], 32_000)).toEqual({});
    expect(outputCapsFor(catalog, [], 32_000)).toEqual({});
    expect(outputCapsFor(catalog, [""], 32_000)).toEqual({});
  });

  it("skips malformed catalog entries", () => {
    expect(outputCapsFor([null, "z-ai/glm-5.2", { id: 42 }, glm], ["z-ai/glm-5.2"], 32_000)).toEqual({
      "z-ai/glm-5.2": 32_000,
    });
  });
});

describe("fetchOpenRouterCatalog", () => {
  const ok = (body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  it("returns the catalog's data array, fetched from the URL openclaw uses", async () => {
    const fetchImpl = ok({ data: [glm, sonnet] });
    expect(await fetchOpenRouterCatalog(env(), fetchImpl)).toEqual([glm, sonnet]);
    expect(fetchImpl).toHaveBeenCalledWith(OPENROUTER_MODELS_URL, expect.anything());
  });

  it("doesn't fetch for a provider other than OpenRouter", async () => {
    const fetchImpl = ok({ data: [glm] });
    expect(await fetchOpenRouterCatalog(env({ LLM_PROVIDER: "anthropic" }), fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("matches the provider case-insensitively", async () => {
    expect(await fetchOpenRouterCatalog(env({ LLM_PROVIDER: " OpenRouter " }), ok({ data: [glm] }))).toEqual([glm]);
  });

  it("fails open: an error status, a bad body or a thrown fetch gives null", async () => {
    const status500 = vi.fn(async () => new Response("down", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchOpenRouterCatalog(env(), status500)).toBeNull();
    expect(await fetchOpenRouterCatalog(env(), ok({ models: [glm] }))).toBeNull();
    expect(await fetchOpenRouterCatalog(env(), ok(null))).toBeNull();
    const notJson = vi.fn(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    expect(await fetchOpenRouterCatalog(env(), notJson)).toBeNull();
    const thrown = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await fetchOpenRouterCatalog(env(), thrown)).toBeNull();
  });
});
