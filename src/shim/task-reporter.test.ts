import { describe, expect, it, vi } from "vitest";

import { TaskReporter } from "./task-reporter.js";

/**
 * These tests exist because of a specific production failure.
 *
 * A long-running task ran to completion, produced a full answer, and reported
 * every heartbeat and its terminal result — and the platform recorded NOTHING.
 * The task row sat at status='running' forever and the caller was never woken.
 * Nothing errored, nothing retried, nothing was logged.
 *
 * The cause was this client's success check: `if (!res.ok)` and nothing else.
 * An auth gateway in front of the console answered 200 with an HTML page, and
 * `res.json().catch(() => ({}))` swallowed it, so every report returned ok:true.
 *
 * A callback client that cannot tell "recorded" from "an HTML login page" is
 * worse than one that fails loudly, because the work is genuinely lost. So the
 * contract is now: JSON, and an `ok: true` the task API actually sent.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeReporter(fetchImpl: typeof fetch) {
  return new TaskReporter({
    taskId: "t-1",
    callbackUrl: "https://console.test/api/tasks/t-1",
    callbackToken: "tok",
    fetchImpl,
    sleepImpl: async () => undefined,
  });
}

describe("TaskReporter.send success contract", () => {
  it("accepts a genuine task-API response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, status: "running", cancel_requested: false }),
    ) as unknown as typeof fetch;
    const ack = await makeReporter(fetchImpl).heartbeat();
    expect(ack.ok).toBe(true);
    expect(ack.cancelRequested).toBe(false);
  });

  it("surfaces a cancellation request from the ack", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, status: "running", cancel_requested: true }),
    ) as unknown as typeof fetch;
    const ack = await makeReporter(fetchImpl).heartbeat();
    expect(ack.cancelRequested).toBe(true);
  });

  it("REJECTS a 200 HTML page — the bug that silently lost a finished task", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("<!doctype html><title>Log in</title>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    ) as unknown as typeof fetch;
    const ack = await makeReporter(fetchImpl).heartbeat();
    expect(ack.ok).toBe(false);
  });

  it("rejects JSON that does not confirm the write", async () => {
    // 200 + JSON, but not from our route (a proxy's own error envelope, say).
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "unauthorized" }),
    ) as unknown as typeof fetch;
    const ack = await makeReporter(fetchImpl).heartbeat();
    expect(ack.ok).toBe(false);
  });

  it("does not follow redirects — a 302 to a login page is a failure", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, {
        status: 307,
        headers: { location: "https://console.test/sso" },
      }),
    ) as unknown as typeof fetch;
    const ack = await makeReporter(fetchImpl).heartbeat();
    expect(ack.ok).toBe(false);
  });

  it("rejects a 4xx", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "token is not scoped to this task" }, 401),
    ) as unknown as typeof fetch;
    const ack = await makeReporter(fetchImpl).heartbeat();
    expect(ack.ok).toBe(false);
  });

  it("treats a network error as a failure, never a silent success", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const ack = await makeReporter(fetchImpl).heartbeat();
    expect(ack.ok).toBe(false);
  });
});

describe("TaskReporter.finish", () => {
  it("retries the terminal report and reports success once it lands", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("network blip");
      return jsonResponse({ ok: true, status: "complete" });
    }) as unknown as typeof fetch;

    const landed = await makeReporter(fetchImpl).finish({
      status: "complete",
      summary: "done",
    });
    expect(landed).toBe(true);
    expect(calls).toBe(3);
  });

  it("gives up after the retry budget and says so", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("<!doctype html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ) as unknown as typeof fetch;

    // The old code returned true on the FIRST of these, which is precisely how a
    // finished task was lost without a trace.
    const landed = await makeReporter(fetchImpl).finish({ status: "complete" });
    expect(landed).toBe(false);
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(4);
  });
});
