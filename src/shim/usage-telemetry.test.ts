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

// openclaw's llm_output fires ONCE per turn with usage summed across the turn's
// calls, so the plugin's `add` runs once per turn carrying openclaw's session id.
// The proxy records each call's cost under the SAME session id (from the request's
// prompt_cache_key); the turn claims the running total.
describe("UsageAccumulator cost correlation", () => {
  it("sums a session's per-call costs and attaches the total to the turn", () => {
    const acc = new UsageAccumulator();
    acc.enableCostCorrelation();
    acc.begin("task:1");
    // openclaw made THREE OpenRouter calls this turn; the proxy costed each.
    acc.recordCost("sess-1", cost({ costUsd: 0.002, upstreamCostUsd: 0.0018 }));
    acc.recordCost("sess-1", cost({ costUsd: 0.001, upstreamCostUsd: 0.0009 }));
    acc.recordCost("sess-1", cost({ costUsd: 0.0005 }));
    // Telemetry fires ONCE for the turn, carrying the openclaw session id.
    acc.add("task:1", sample(), "sess-1");

    const totals = acc.drain("task:1");
    expect(totals?.costUsd).toBeCloseTo(0.0035, 10);
    expect(totals?.upstreamCostUsd).toBeCloseTo(0.0027, 10);
    expect(totals?.costedCalls).toBe(3); // the REAL call count, though modelCalls=1
    expect(totals?.modelCalls).toBe(1);
  });

  it("falls back to the shim session key when the proxy keyed by that", () => {
    const acc = new UsageAccumulator();
    acc.enableCostCorrelation();
    acc.begin("task:2");
    // prompt_cache_key turned out to equal the shim's own session key.
    acc.recordCost("task:2", cost({ costUsd: 0.004 }));
    acc.add("task:2", sample(), undefined); // no session id reported

    expect(acc.drain("task:2")?.costUsd).toBeCloseTo(0.004, 10);
  });

  it("does NO correlation until enabled (non-OpenRouter / proxy-off deployments)", () => {
    const acc = new UsageAccumulator();
    // enableCostCorrelation NOT called.
    acc.begin("task:3");
    acc.recordCost("sess-3", cost());
    acc.add("task:3", sample(), "sess-3");
    expect(acc.drain("task:3")?.costUsd).toBeUndefined();
  });

  it("attributes concurrent turns' costs to the right session", () => {
    const acc = new UsageAccumulator();
    acc.enableCostCorrelation();
    acc.begin("task:a");
    acc.begin("task:b");
    acc.recordCost("sess-a", cost({ costUsd: 0.01 }));
    acc.recordCost("sess-b", cost({ costUsd: 0.05 }));
    acc.recordCost("sess-a", cost({ costUsd: 0.01 }));
    acc.add("task:b", sample(), "sess-b");
    acc.add("task:a", sample(), "sess-a");

    expect(acc.drain("task:a")?.costUsd).toBeCloseTo(0.02, 10);
    expect(acc.drain("task:b")?.costUsd).toBeCloseTo(0.05, 10);
  });

  it("claims a session's cost once, so the next turn starts fresh", () => {
    const acc = new UsageAccumulator();
    acc.enableCostCorrelation();
    // Turn 1 on a long-lived (webchat) session.
    acc.begin("webchat:c");
    acc.recordCost("sess-c", cost({ costUsd: 0.01 }));
    acc.add("webchat:c", sample(), "sess-c");
    expect(acc.drain("webchat:c")?.costUsd).toBeCloseTo(0.01, 10);
    // Turn 2 on the same session, new cost — must not re-count turn 1's.
    acc.begin("webchat:c");
    acc.recordCost("sess-c", cost({ costUsd: 0.02 }));
    acc.add("webchat:c", sample(), "sess-c");
    expect(acc.drain("webchat:c")?.costUsd).toBeCloseTo(0.02, 10);
  });

  it("ignores cost for a session with no open turn, without leaking a bucket", () => {
    const acc = new UsageAccumulator();
    acc.enableCostCorrelation();
    // A heartbeat/subagent call the shim never bracketed.
    expect(() => acc.recordCost("sess-x", cost())).not.toThrow();
    acc.begin("task:6");
    acc.add("task:6", sample(), "sess-6"); // different session id
    expect(acc.drain("task:6")?.costUsd).toBeUndefined();
  });
});
