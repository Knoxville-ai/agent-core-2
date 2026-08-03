import { describe, expect, it } from "vitest";

import { parseUsageSample, UsageAccumulator, type UsageSample } from "./usage-telemetry.js";

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
