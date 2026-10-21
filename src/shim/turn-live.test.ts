import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  StreamingRowWriter,
  TurnBroadcaster,
  TurnLocks,
  type TurnEvent,
  type TurnPublisher,
} from "./turn-live.js";

describe("TurnLocks", () => {
  it("runs turns on one conversation one at a time, in arrival order", async () => {
    const locks = new TurnLocks();
    const order: string[] = [];
    const releaseA = await locks.acquire("c1");
    const b = locks.acquire("c1").then((release) => {
      order.push("b");
      return release;
    });
    const c = locks.acquire("c1").then((release) => {
      order.push("c");
      release();
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    order.push("a");
    releaseA();
    (await b)();
    await c;
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("does not hold other conversations behind a busy one", async () => {
    const locks = new TurnLocks();
    await locks.acquire("c1");
    const other = await locks.acquire("c2");
    other();
  });

  it("release is idempotent", async () => {
    const locks = new TurnLocks();
    const release = await locks.acquire("c1");
    release();
    release();
    (await locks.acquire("c1"))();
  });

  it("drain waits for held locks and reports a timeout", async () => {
    const locks = new TurnLocks();
    expect(await locks.drain(10)).toBe(true);
    const release = await locks.acquire("c1");
    expect(await locks.drain(10)).toBe(false);
    setTimeout(release, 5);
    expect(await locks.drain(1_000)).toBe(true);
  });
});

describe("StreamingRowWriter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces updates into one save per interval", async () => {
    const saves: string[] = [];
    const w = new StreamingRowWriter(
      { saveStreamingContent: async (_id, c) => (saves.push(c), true) },
      "m1",
      1_000,
    );
    w.update("H");
    w.update("He");
    w.update("Hello");
    expect(saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saves).toEqual(["Hello"]);
    w.update("Hello there");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saves).toEqual(["Hello", "Hello there"]);
  });

  it("settle waits for the in-flight save and stops further saves", async () => {
    let finish!: () => void;
    const saves: string[] = [];
    const w = new StreamingRowWriter(
      {
        saveStreamingContent: (_id, c) =>
          new Promise<boolean>((r) => {
            saves.push(c);
            finish = () => r(true);
          }),
      },
      "m1",
      1_000,
    );
    w.update("partial");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saves).toEqual(["partial"]);
    let settled = false;
    const s = w.settle().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await s;
    w.update("after");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(saves).toEqual(["partial"]);
  });

  it("survives a failed save and retries with the latest text", async () => {
    const calls: string[] = [];
    const w = new StreamingRowWriter(
      {
        saveStreamingContent: async (_id, c) => {
          calls.push(c);
          if (calls.length === 1) throw new Error("network");
          return true;
        },
      },
      "m1",
      1_000,
    );
    w.update("a");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual(["a", "a"]);
  });
});

describe("TurnBroadcaster", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function recorder() {
    const sent: Array<{ topic: string; events: TurnEvent[] }> = [];
    const publisher: TurnPublisher = {
      async publish(topic, events) {
        sent.push({ topic, events });
      },
    };
    return { sent, publisher };
  }

  it("coalesces token deltas and keeps the offset of the first one", async () => {
    const { sent, publisher } = recorder();
    const b = new TurnBroadcaster(publisher, "c1", "m1", 100);
    b.token("Hel", 0);
    b.token("lo", 3);
    await vi.advanceTimersByTimeAsync(100);
    b.token("!", 5);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.map((s) => s.topic)).toEqual(["conversation:c1", "conversation:c1"]);
    expect(sent.map((s) => s.events)).toEqual([
      [{ type: "token", message_id: "m1", offset: 0, delta: "Hello" }],
      [{ type: "token", message_id: "m1", offset: 5, delta: "!" }],
    ]);
  });

  it("flushes pending tokens ahead of a control event, in order, and closes on done", async () => {
    const { sent, publisher } = recorder();
    const b = new TurnBroadcaster(publisher, "c1", "m1", 100);
    b.start("u1");
    b.token("Hi", 0);
    await b.done("complete");
    b.token("late", 2);
    await vi.advanceTimersByTimeAsync(500);
    expect(sent.map((s) => s.events)).toEqual([
      [{ type: "start", message_id: "m1", user_message_id: "u1" }],
      [
        { type: "token", message_id: "m1", offset: 0, delta: "Hi" },
        { type: "done", message_id: "m1", status: "complete" },
      ],
    ]);
  });

  it("never lets a publish failure escape", async () => {
    const publisher: TurnPublisher = {
      publish: vi.fn(async () => {
        throw new Error("realtime down");
      }),
    };
    const b = new TurnBroadcaster(publisher, "c1", "m1", 100);
    b.token("x", 0);
    await vi.advanceTimersByTimeAsync(100);
    await expect(b.done("error")).resolves.toBeUndefined();
    expect(publisher.publish).toHaveBeenCalledTimes(2);
  });
});
