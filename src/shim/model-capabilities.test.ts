import { describe, expect, it } from "vitest";

import { lookupCapabilities, resolveCapabilities } from "./model-capabilities.js";

/**
 * These exist because of a silent failure, not a hypothetical one.
 *
 * The fleet default is `LLM_PROVIDER=openrouter`, and an OpenRouter model id
 * carries its own upstream provider (`anthropic/claude-sonnet-4-6`). The table
 * and every heuristic key on that upstream name, so before the router unwrap
 * `lookupCapabilities("openrouter", …)` matched nothing and returned the
 * text-only default — dropping image attachments for any model whose console
 * catalog row left `multimodal` NULL, with no error anywhere.
 */
describe("lookupCapabilities", () => {
  it("resolves a router model through its upstream provider", () => {
    expect(lookupCapabilities("openrouter", "anthropic/claude-sonnet-4-6")).toEqual({
      multimodal: true,
      fileInput: false,
    });
    expect(lookupCapabilities("openrouter", "openai/gpt-4o")).toEqual({
      multimodal: true,
      fileInput: false,
    });
    expect(lookupCapabilities("openrouter", "google/gemini-2.0-flash")).toEqual({
      multimodal: true,
      fileInput: false,
    });
  });

  it("reaches the heuristic through the router, not just the exact table", () => {
    // gpt-5.4-mini is in the table; this checks a family member that is not.
    expect(
      lookupCapabilities("openrouter", "openai/gpt-5.9-turbo").multimodal,
    ).toBe(true);
    expect(lookupCapabilities("openrouter", "anthropic/claude-future-1").multimodal).toBe(
      true,
    );
  });

  it("stays text-only for a routed model nobody has vouched for", () => {
    // The conservative half of the contract: inlining an image into a
    // text-only model is an upstream 400, so an unknown family stays false.
    expect(lookupCapabilities("openrouter", "qwen/qwen3.7-plus")).toEqual({
      multimodal: false,
      fileInput: false,
    });
  });

  it("does not unwrap a router ref with no upstream prefix", () => {
    expect(lookupCapabilities("openrouter", "some-bare-model").multimodal).toBe(false);
    expect(lookupCapabilities("openrouter", "trailing/").multimodal).toBe(false);
    expect(lookupCapabilities("openrouter", "/leading").multimodal).toBe(false);
  });

  it("unwraps at most one hop, so a pathological ref terminates", () => {
    // After one unwrap this is ("openrouter", "anthropic/claude-…"), which is
    // a router again — the hop budget stops it there rather than letting the
    // depth ride on the id happening to run out of segments.
    expect(
      lookupCapabilities("openrouter", "openrouter/anthropic/claude-sonnet-4-6")
        .multimodal,
    ).toBe(false);
  });

  it("still honours the direct providers", () => {
    expect(lookupCapabilities("openai", "gpt-4o").multimodal).toBe(true);
    expect(lookupCapabilities("openai", "o3-mini").multimodal).toBe(false);
    expect(lookupCapabilities("anthropic", "claude-opus-4-8").multimodal).toBe(true);
    expect(lookupCapabilities("ollama", "llama3").multimodal).toBe(false);
  });

  it("never infers fileInput — no provider path is wired for it", () => {
    for (const ref of [
      ["openrouter", "anthropic/claude-sonnet-4-6"],
      ["openai", "gpt-4o"],
      ["anthropic", "claude-opus-4-8"],
    ] as const) {
      expect(lookupCapabilities(ref[0], ref[1]).fileInput).toBe(false);
    }
  });

  it("is case- and whitespace-insensitive on the provider", () => {
    expect(lookupCapabilities(" OpenRouter ", "anthropic/claude-sonnet-4-6").multimodal)
      .toBe(true);
  });
});

describe("resolveCapabilities", () => {
  it("lets an explicit override win over the table", () => {
    // The console catalog's escape hatch for a model the table cannot know.
    expect(
      resolveCapabilities("openrouter", "qwen/qwen3.7-plus", { multimodal: true }),
    ).toEqual({ multimodal: true, fileInput: false });
    expect(
      resolveCapabilities("openrouter", "anthropic/claude-sonnet-4-6", {
        multimodal: false,
      }).multimodal,
    ).toBe(false);
  });

  it("falls back to the table when the override is undefined", () => {
    // `undefined` means "the catalog row said NULL — use the static table",
    // which is exactly the path that was returning text-only for every
    // OpenRouter model.
    expect(
      resolveCapabilities("openrouter", "anthropic/claude-sonnet-4-6", {
        multimodal: undefined,
      }).multimodal,
    ).toBe(true);
  });
});
