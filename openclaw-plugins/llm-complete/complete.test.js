import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  createCompleteHandler,
  parseCompleteRequest,
  readJsonBody,
  toCompleteResponse,
} from "./complete.js";

function fakeReq(method, body) {
  const chunks =
    body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  return req;
}

/** Just enough of a ServerResponse for the handler: status, headers, one body. */
function fakeRes() {
  const res = new EventEmitter();
  Object.assign(res, {
    statusCode: 0,
    body: "",
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    writeHead(status) {
      res.statusCode = status;
      return res;
    },
    end(payload) {
      res.body = payload ?? "";
      res.writableEnded = true;
      res.writableFinished = true;
    },
  });
  return res;
}

function apiWith(complete) {
  return { runtime: { llm: { complete } } };
}

const VALID = {
  system: "Name the conversation.",
  messages: [{ role: "user", content: "can you reconcile the June invoices" }],
  max_tokens: 1024,
  timeout_ms: 5000,
  purpose: "knox-conversation-title",
};

describe("parseCompleteRequest", () => {
  it("maps the wire body onto llm.complete params", () => {
    expect(parseCompleteRequest(VALID)).toEqual({
      ok: true,
      params: {
        systemPrompt: "Name the conversation.",
        messages: [{ role: "user", content: "can you reconcile the June invoices" }],
        maxTokens: 1024,
        timeoutMs: 5000,
        purpose: "knox-conversation-title",
      },
    });
  });

  it("rejects a body that is not an object", () => {
    for (const body of [null, "text", [1, 2], 42]) {
      expect(parseCompleteRequest(body).ok, JSON.stringify(body)).toBe(false);
    }
  });

  it("requires at least one message", () => {
    expect(parseCompleteRequest({ messages: [] }).ok).toBe(false);
    expect(parseCompleteRequest({}).ok).toBe(false);
  });

  it("only accepts user and assistant messages with string content", () => {
    for (const m of [
      { role: "system", content: "x" },
      { role: "tool", content: "x" },
      { role: "user", content: 7 },
      { role: "user" },
      null,
    ]) {
      expect(parseCompleteRequest({ messages: [m] }).ok, JSON.stringify(m)).toBe(false);
    }
  });

  it("drops fields the route does not support", () => {
    const parsed = parseCompleteRequest({
      messages: [{ role: "user", content: "hi", name: "x" }],
      model: "openai/gpt-5.4",
      temperature: 0.2,
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.params).not.toHaveProperty("model");
    expect(parsed.params).not.toHaveProperty("temperature");
    expect(parsed.params.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("defaults the timeout and purpose and caps the timeout", () => {
    const base = parseCompleteRequest({ messages: [{ role: "user", content: "hi" }] });
    expect(base.params.timeoutMs).toBe(30_000);
    expect(base.params.purpose).toBe("knox-llm-complete");
    const huge = parseCompleteRequest({
      messages: [{ role: "user", content: "hi" }],
      timeout_ms: 10 * 60_000,
    });
    expect(huge.params.timeoutMs).toBe(120_000);
  });

  it("omits a blank system prompt and a non-positive max_tokens", () => {
    const parsed = parseCompleteRequest({
      system: "   ",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 0,
    });
    expect(parsed.params).not.toHaveProperty("systemPrompt");
    expect(parsed.params).not.toHaveProperty("maxTokens");
  });
});

describe("toCompleteResponse", () => {
  it("returns the text and usage counts", () => {
    expect(
      toCompleteResponse({
        text: "Reconcile June invoices",
        provider: "openrouter",
        model: "qwen/qwen3.7-plus",
        agentId: "main",
        usage: { inputTokens: 210, outputTokens: 6, totalTokens: 216, costUsd: 0.00004 },
        audit: { caller: { kind: "plugin" } },
      }),
    ).toEqual({
      text: "Reconcile June invoices",
      provider: "openrouter",
      model: "qwen/qwen3.7-plus",
      usage: { input_tokens: 210, output_tokens: 6, cost_usd: 0.00004 },
    });
  });

  it("tolerates a sparse result", () => {
    expect(toCompleteResponse({})).toEqual({
      text: "",
      provider: null,
      model: null,
      usage: { input_tokens: null, output_tokens: null, cost_usd: null },
    });
  });
});

describe("readJsonBody", () => {
  it("parses a JSON body and returns null for an empty one", async () => {
    expect(await readJsonBody(fakeReq("POST", { a: 1 }))).toEqual({ a: 1 });
    expect(await readJsonBody(fakeReq("POST"))).toBeNull();
  });

  it("rejects invalid JSON and an oversized body", async () => {
    await expect(readJsonBody(fakeReq("POST", "{nope"))).rejects.toThrow("invalid JSON body");
    await expect(readJsonBody(fakeReq("POST", { pad: "x".repeat(100) }), 10)).rejects.toThrow(
      "request body too large",
    );
  });
});

describe("createCompleteHandler", () => {
  it("runs the completion on the agent's model and returns its text", async () => {
    const calls = [];
    const handler = createCompleteHandler(
      apiWith(async (params) => {
        calls.push(params);
        return {
          text: "Reconcile June invoices",
          provider: "openrouter",
          model: "qwen/qwen3.7-plus",
          usage: { inputTokens: 210, outputTokens: 6 },
        };
      }),
    );
    const res = fakeRes();
    expect(await handler(fakeReq("POST", VALID), res)).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).text).toBe("Reconcile June invoices");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      systemPrompt: "Name the conversation.",
      messages: VALID.messages,
      maxTokens: 1024,
      purpose: "knox-conversation-title",
    });
    expect(calls[0]).not.toHaveProperty("timeoutMs");
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("answers 405 to anything but POST", async () => {
    const res = fakeRes();
    await createCompleteHandler(apiWith(async () => ({ text: "x" })))(fakeReq("GET"), res);
    expect(res.statusCode).toBe(405);
  });

  it("answers 501 when this openclaw has no completion runtime", async () => {
    const res = fakeRes();
    await createCompleteHandler({ runtime: {} })(fakeReq("POST", VALID), res);
    expect(res.statusCode).toBe(501);
  });

  it("answers 400 to a malformed request without calling the model", async () => {
    let called = false;
    const handler = createCompleteHandler(
      apiWith(async () => {
        called = true;
        return { text: "x" };
      }),
    );
    for (const body of ["{nope", { messages: [] }]) {
      const res = fakeRes();
      await handler(fakeReq("POST", body), res);
      expect(res.statusCode).toBe(400);
    }
    expect(called).toBe(false);
  });

  it("answers 502 when the model call fails", async () => {
    const res = fakeRes();
    await createCompleteHandler(
      apiWith(async () => {
        throw new Error("Plugin LLM completion failed: No API key for provider openrouter");
      }),
    )(fakeReq("POST", VALID), res);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error).toContain("No API key");
  });

  it("answers 502 when the model comes back with no text (a provider error that didn't throw)", async () => {
    const res = fakeRes();
    await createCompleteHandler(
      apiWith(async () => ({ text: "  ", provider: "openai", model: "gpt-4o-mini", usage: {} })),
    )(fakeReq("POST", VALID), res);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error).toBe("model returned no text");
  });

  it("aborts the model call and answers 504 once timeout_ms passes", async () => {
    const res = fakeRes();
    await createCompleteHandler(
      apiWith(
        (params) =>
          new Promise((_resolve, reject) => {
            params.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    )(fakeReq("POST", { ...VALID, timeout_ms: 5 }), res);
    expect(res.statusCode).toBe(504);
  });

  it("aborts the model call when the caller hangs up", async () => {
    let seen;
    const res = fakeRes();
    const pending = createCompleteHandler(
      apiWith(
        (params) =>
          new Promise((_resolve, reject) => {
            seen = params.signal;
            params.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    )(fakeReq("POST", VALID), res);
    await new Promise((r) => setTimeout(r, 0));
    // The connection closes before any response was written.
    res.destroyed = true;
    res.emit("close");
    await pending;
    expect(seen.aborted).toBe(true);
    expect(res.body).toBe("");
  });
});
