import { describe, expect, it } from "vitest";

import { costSampleFromPayload, sniffUsageCost } from "./cost-sniffer.js";

/** Build a realistic OpenRouter streaming body, usage on the trailing frame. */
function sseBody(usage: Record<string, unknown> | null): string {
  const frames = [
    `data: ${JSON.stringify({ id: "gen-abc", model: "qwen/qwen3.7-plus", choices: [{ delta: { content: "hi" } }] })}`,
    `data: ${JSON.stringify({ id: "gen-abc", model: "qwen/qwen3.7-plus", choices: [{ delta: { content: " there" } }] })}`,
  ];
  if (usage) {
    frames.push(
      `data: ${JSON.stringify({ id: "gen-abc", model: "qwen/qwen3.7-plus", choices: [], usage })}`,
    );
  }
  frames.push("data: [DONE]");
  return frames.map((f) => `${f}\n\n`).join("");
}

function feed(body: string, contentType: string | undefined, chunkSize = 0) {
  const parser = sniffUsageCost(contentType);
  const buf = Buffer.from(body, "utf8");
  if (chunkSize <= 0) {
    parser.push(buf);
  } else {
    for (let i = 0; i < buf.length; i += chunkSize) {
      parser.push(buf.subarray(i, i + chunkSize));
    }
  }
  return parser.finish();
}

describe("costSampleFromPayload", () => {
  it("extracts cost, tokens, upstream cost, model and gen id", () => {
    const sample = costSampleFromPayload({
      id: "gen-xyz",
      model: "qwen/qwen3.7-plus",
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        cost: 0.0021,
        cost_details: { upstream_inference_cost: 0.0019 },
      },
    });
    expect(sample).toEqual({
      costUsd: 0.0021,
      promptTokens: 1000,
      completionTokens: 50,
      upstreamCostUsd: 0.0019,
      model: "qwen/qwen3.7-plus",
      generationId: "gen-xyz",
    });
  });

  it("records a genuine $0 (free/BYOK) call — cost is present, just zero", () => {
    const sample = costSampleFromPayload({
      usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0 },
    });
    expect(sample?.costUsd).toBe(0);
  });

  it("returns null when cost is absent (nothing to attribute)", () => {
    expect(
      costSampleFromPayload({ usage: { prompt_tokens: 5, completion_tokens: 5 } }),
    ).toBeNull();
  });

  it("returns null when the token counts we correlate by are missing", () => {
    expect(costSampleFromPayload({ usage: { cost: 0.01 } })).toBeNull();
  });

  it.each([
    ["null", null],
    ["no usage", { id: "x" }],
    ["usage not an object", { usage: 3 }],
    ["non-numeric cost", { usage: { prompt_tokens: 1, completion_tokens: 1, cost: "1" } }],
  ])("rejects %s", (_label, payload) => {
    expect(costSampleFromPayload(payload)).toBeNull();
  });
});

describe("sniffUsageCost — streaming (SSE)", () => {
  it("reads cost off the trailing usage frame", () => {
    const sample = feed(
      sseBody({ prompt_tokens: 1000, completion_tokens: 50, cost: 0.0021 }),
      "text/event-stream",
    );
    expect(sample).toMatchObject({ costUsd: 0.0021, promptTokens: 1000, completionTokens: 50 });
  });

  it("survives usage frames split across chunk boundaries (1 byte at a time)", () => {
    const sample = feed(
      sseBody({ prompt_tokens: 1234, completion_tokens: 77, cost: 0.005 }),
      "text/event-stream",
      1,
    );
    expect(sample).toMatchObject({ costUsd: 0.005, promptTokens: 1234, completionTokens: 77 });
  });

  it("returns null when the stream never carried a usage.cost", () => {
    expect(feed(sseBody(null), "text/event-stream")).toBeNull();
  });

  it("keeps the LAST cost-bearing frame when several appear", () => {
    const body =
      `data: ${JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } })}\n\n` +
      `data: ${JSON.stringify({ usage: { prompt_tokens: 2, completion_tokens: 2, cost: 0.002 } })}\n\n` +
      "data: [DONE]\n\n";
    expect(feed(body, "text/event-stream")).toMatchObject({ costUsd: 0.002 });
  });

  it("detects SSE without a content-type by peeking at the body", () => {
    const sample = feed(
      sseBody({ prompt_tokens: 10, completion_tokens: 2, cost: 0.0001 }),
      undefined,
    );
    expect(sample).toMatchObject({ costUsd: 0.0001 });
  });

  it("ignores malformed data frames without throwing", () => {
    const body =
      "data: {not json}\n\n" +
      `data: ${JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 3, cost: 0.003 } })}\n\n` +
      "data: [DONE]\n\n";
    expect(feed(body, "text/event-stream")).toMatchObject({ costUsd: 0.003 });
  });
});

describe("sniffUsageCost — non-streaming (JSON)", () => {
  it("reads cost off the response body", () => {
    const body = JSON.stringify({
      id: "gen-json",
      model: "qwen/qwen3.7-plus",
      usage: { prompt_tokens: 800, completion_tokens: 40, cost: 0.0015 },
    });
    expect(feed(body, "application/json")).toMatchObject({
      costUsd: 0.0015,
      promptTokens: 800,
      completionTokens: 40,
      generationId: "gen-json",
    });
  });

  it("reads a body delivered in many small chunks", () => {
    const body = JSON.stringify({
      usage: { prompt_tokens: 42, completion_tokens: 9, cost: 0.0009 },
    });
    expect(feed(body, "application/json", 3)).toMatchObject({ costUsd: 0.0009 });
  });

  it("returns null on a body with no usage.cost", () => {
    expect(feed(JSON.stringify({ choices: [] }), "application/json")).toBeNull();
  });

  it("returns null on an oversize body rather than buffering unbounded", () => {
    // 9 MB of filler exceeds the 8 MB JSON cap → sniffing gives up (fail-open).
    const huge = JSON.stringify({ pad: "x".repeat(9_000_000), usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 } });
    expect(feed(huge, "application/json", 1_000_000)).toBeNull();
  });
});
