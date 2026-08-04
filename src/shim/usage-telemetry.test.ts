import { describe, expect, it } from "vitest";

import {
  parseUsageSample,
  UsageAccumulator,
  type CostSample,
  type UsageSample,
} from "./usage-telemetry.js";

const sample = (over: Partial<UsageSample> = {}): UsageSample => ({
  input: 100,
  output: 10,
  cache_read: 0,
  cache_write: 0,
  ...over,
});

describe("parseUsageSample", () => {
  it("parses a well-formed body", () => {
    expect(
      parseUsageSample({
        session_key: "task:1",
        sample: { input: 5, output: 6, cache_read: 7, cache_write: 8, total: 26 },
      }),
    ).toEqual({ input: 5, output: 6, cache_read: 7, cache_write: 8, total: 26 });
  });

  it("carries provider/model/resolved_ref when present", () => {
    const parsed = parseUsageSample({
      sample: {
        input: 1,
        output: 1,
        cache_read: 0,
        cache_write: 0,
        provider: "openrouter",
        model: "qwen3.7-plus",
        resolved_ref: "openrouter/qwen/qwen3.7-plus",
      },
    });
    expect(parsed?.resolved_ref).toBe("openrouter/qwen/qwen3.7-plus");
    expect(parsed?.provider).toBe("openrouter");
  });

  // This body crosses an HTTP boundary from a plugin, so it is untrusted.
  it.each([
    ["null body", null],
    ["no sample key", { session_key: "x" }],
    ["sample not an object", { sample: "nope" }],
    ["all-zero sample", { sample: { input: 0, output: 0, cache_read: 0, cache_write: 0 } }],
  ])("rejects %s", (_label, body) => {
    expect(parseUsageSample(body)).toBeNull();
  });

  it("coerces negative, fractional, and non-numeric counts to safe integers", () => {
    expect(
      parseUsageSample({
        sample: { input: -5, output: 3.7, cache_read: "12", cache_write: Number.NaN },
      }),
    ).toEqual({ input: 0, output: 3, cache_read: 0, cache_write: 0 });
  });
});

describe("UsageAccumulator", () => {
  it("rolls up every model call in a turn", () => {
    const acc = new UsageAccumulator();
    acc.begin("task:1");
    acc.add("task:1", sample({ input: 100, cache_read: 900, cache_write: 50 }));
    acc.add("task:1", sample({ input: 200, cache_read: 800 }));

    const totals = acc.drain("task:1");
    expect(totals).toEqual({
      modelCalls: 2,
      uncachedInput: 300,
      cacheRead: 1700,
      cacheWrite: 50,
    });
  });

  it("drops samples with no open turn rather than inventing a bucket", () => {
    const acc = new UsageAccumulator();
    // A heartbeat / subagent / cron wake the shim never started.
    acc.add("webchat:orphan", sample());
    expect(acc.drain("webchat:orphan")).toBeNull();
    expect(acc.size()).toBe(0);
  });

  it("returns null for a turn where no model call was reported", () => {
    const acc = new UsageAccumulator();
    acc.begin("task:2");
    expect(acc.drain("task:2")).toBeNull();
  });

  it("resets on begin so a retried turn does not inherit the last attempt", () => {
    const acc = new UsageAccumulator();
    acc.begin("task:3");
    acc.add("task:3", sample({ input: 999 }));
    acc.begin("task:3");
    acc.add("task:3", sample({ input: 1 }));
    expect(acc.drain("task:3")?.uncachedInput).toBe(1);
  });

  it("drain and clear both free the bucket", () => {
    const acc = new UsageAccumulator();
    acc.begin("a");
    acc.begin("b");
    acc.add("a", sample());
    expect(acc.size()).toBe(2);
    acc.drain("a");
    acc.clear("b");
    expect(acc.size()).toBe(0);
    // Draining twice is safe (the message path drains in a `finally`).
    expect(acc.drain("a")).toBeNull();
  });

  it("keeps turns isolated by session key", () => {
    const acc = new UsageAccumulator();
    acc.begin("task:x");
    acc.begin("task:y");
    acc.add("task:x", sample({ input: 10 }));
    acc.add("task:y", sample({ input: 20 }));
    expect(acc.drain("task:x")?.uncachedInput).toBe(10);
    expect(acc.drain("task:y")?.uncachedInput).toBe(20);
  });

  it("records the last resolved ref seen in the turn", () => {
    const acc = new UsageAccumulator();
    acc.begin("task:r");
    acc.add("task:r", sample({ resolved_ref: "openrouter/a" }));
    acc.add("task:r", sample());
    acc.add("task:r", sample({ resolved_ref: "openrouter/b" }));
    expect(acc.drain("task:r")?.resolvedRef).toBe("openrouter/b");
  });
});

const cost = (over: Partial<CostSample> = {}): CostSample => ({
  costUsd: 0.002,
  promptTokens: 1000,
  completionTokens: 50,
  ...over,
});

// The plugin's `input` is cache-EXCLUSIVE, so a call with input=I, cache_read=C,
// output=O correlates to OpenRouter's prompt_tokens = I+C, completion_tokens = O.
const callSample = (over: Partial<UsageSample> = {}): UsageSample =>
  sample({ input: 100, cache_read: 900, output: 50, ...over }); // tuple (1000, 50)

describe("UsageAccumulator cost correlation", () => {
  it("folds an actual cost when the proxy wins the race (cost before usage)", () => {
    const acc = new UsageAccumulator();
    acc.enableCostCorrelation();
    acc.begin("task:1");
    acc.recordCost(cost({ costUsd: 0.002, upstreamCostUsd: 0.0018 }));
    acc.add("task:1", callSample());

    const totals = acc.drain("task:1");
    expect(totals?.costUsd).toBeCloseTo(0.002, 10);
    expect(totals?.upstreamCostUsd).toBeCloseTo(0.0018, 10);
    expect(totals?.costedCalls).toBe(1);
  });

  it("folds an actual cost on the reverse race (usage before cost)", () => {
    const acc = new UsageAccumulator();
    acc.enableCostCorrelation();
    acc.begin("task:2");
    acc.add("task:2", callSample());
    acc.recordCost(cost({ costUsd: 0.003 }));

    expect(acc.drain("task:2")?.costUsd).toBeCloseTo(0.003, 10);
  });

  it("does NO correlation until enabled (non-OpenRouter / proxy-off deployments)", () => {
    const acc = new UsageAccumulator();
    // enableCostCorrelation NOT called.
    acc.begin("task:3");
    acc.recordCost(cost());
    acc.add("task:3", callSample());
    expect(acc.drain("task:3")?.costUsd).toBeUndefined();
  });

  it("sums cost across a turn's model calls and counts coverage", () => {
    const acc = new UsageAccumulator();
    acc.enableCostCorrelation();
    acc.begin("task:4");
    // Two costed calls with distinct token tuples.
    acc.recordCost(cost({ promptTokens: 1000, completionTokens: 50, costUsd: 0.002 }));
    acc.add("task:4", callSample({ input: 100, cache_read: 900, output: 50 }));
    acc.recordCost(cost({ promptTokens: 500, completionTokens: 20, costUsd: 0.001 }));
    acc.add("task:4", callSample({ input: 500, cache_read: 0, output: 20 }));
    // A third call the proxy never priced (e.g. a non-OpenRouter fallback call).
    acc.add("task:4", callSample({ input: 10, cache_read: 0, output: 1 }));

    const totals = acc.drain("task:4");
    expect(totals?.modelCalls).toBe(3);
    expect(totals?.costUsd).toBeCloseTo(0.003, 10);
    expect(totals?.costedCalls).toBe(2); // honest coverage: 2 of 3 calls priced
  });

  it("attributes concurrent turns' costs to the right session by token tuple", () => {
    const acc = new UsageAccumulator();
    acc.enableCostCorrelation();
    acc.begin("task:a");
    acc.begin("task:b");
    // Distinct tuples per turn.
    acc.recordCost(cost({ promptTokens: 1000, completionTokens: 50, costUsd: 0.01 }));
    acc.recordCost(cost({ promptTokens: 2000, completionTokens: 99, costUsd: 0.05 }));
    acc.add("task:b", callSample({ input: 2000, cache_read: 0, output: 99 }));
    acc.add("task:a", callSample({ input: 1000, cache_read: 0, output: 50 }));

    expect(acc.drain("task:a")?.costUsd).toBeCloseTo(0.01, 10);
    expect(acc.drain("task:b")?.costUsd).toBeCloseTo(0.05, 10);
  });

  it("drops a straggler cost that arrives after the turn drained", () => {
    const acc = new UsageAccumulator();
    acc.enableCostCorrelation();
    acc.begin("task:5");
    acc.add("task:5", callSample());
    acc.drain("task:5"); // turn closed, row written
    // A late cost for the same tuple must not throw or resurrect the turn.
    expect(() => acc.recordCost(cost())).not.toThrow();
    expect(acc.size()).toBe(0);
  });

  it("ignores a cost whose call never belonged to a tracked turn", () => {
    const acc = new UsageAccumulator();
    acc.enableCostCorrelation();
    // No begin() — a heartbeat/subagent call the shim never bracketed.
    expect(() => acc.recordCost(cost())).not.toThrow();
    acc.begin("task:6");
    acc.add("task:6", callSample({ input: 7, cache_read: 0, output: 7 })); // different tuple
    expect(acc.drain("task:6")?.costUsd).toBeUndefined();
  });
});
