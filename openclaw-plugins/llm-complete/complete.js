// Dependency-free logic for the llm-complete plugin, split out from index.js so
// it can be unit-tested without loading the OpenClaw SDK.
//
// The plugin exposes ONE loopback route that runs a single completion on the
// agent's own model through openclaw's host-owned `api.runtime.llm.complete`:
// the same provider, credentials (API key or OAuth profile) and base URL (the
// OpenRouter cost proxy included) as the agent's turns, but none of the agent's
// prompt, tools or session. The shim uses it for small side tasks that must not
// ride an agent turn, such as naming a conversation
// (src/shim/conversation-title.ts).

/** Gateway HTTP path of the completion route. The shim's
 *  src/shim/conversation-title.ts calls the same path; keep the two in sync. */
export const LLM_COMPLETE_PATH = "/knox/llm-complete";

/** A request is a short system prompt plus a few messages. Anything bigger is a
 *  bug in the caller, not a use case. */
export const MAX_BODY_BYTES = 256 * 1024;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_PURPOSE_CHARS = 80;
const MAX_ERROR_CHARS = 300;

function positiveInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function count(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function errorMessage(err) {
  return String(err instanceof Error ? err.message : err).slice(0, MAX_ERROR_CHARS);
}

/**
 * Validate a request body into `api.runtime.llm.complete` params plus the
 * route's own `timeoutMs`. Wire shape (snake_case, like the shim's other
 * loopback routes):
 *
 *   { system?, messages: [{ role: "user"|"assistant", content }],
 *     max_tokens?, timeout_ms?, purpose? }
 *
 * There is deliberately no model override (the call always runs on the agent's
 * default model) and no temperature (several reasoning models reject one).
 */
export function parseCompleteRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, error: "messages must be a non-empty array" };
  }
  const messages = [];
  for (const m of body.messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
      return { ok: false, error: "each message needs role user|assistant and string content" };
    }
    messages.push({ role: m.role, content: m.content });
  }
  const params = {
    messages,
    timeoutMs: Math.min(positiveInt(body.timeout_ms) ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    purpose:
      typeof body.purpose === "string" && body.purpose.trim()
        ? body.purpose.trim().slice(0, MAX_PURPOSE_CHARS)
        : "knox-llm-complete",
  };
  if (typeof body.system === "string" && body.system.trim()) params.systemPrompt = body.system;
  const maxTokens = positiveInt(body.max_tokens);
  if (maxTokens) params.maxTokens = maxTokens;
  return { ok: true, params };
}

/** The reply the shim reads: the text plus usage COUNTS for its logs. */
export function toCompleteResponse(result) {
  const usage = result?.usage ?? {};
  return {
    text: typeof result?.text === "string" ? result.text : "",
    provider: typeof result?.provider === "string" ? result.provider : null,
    model: typeof result?.model === "string" ? result.model : null,
    usage: {
      input_tokens: count(usage.inputTokens),
      output_tokens: count(usage.outputTokens),
      cost_usd: count(usage.costUsd),
    },
  };
}

/** Read and parse a JSON request body. Null when the body is empty. */
export async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buf.length;
    if (received > limit) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (received === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid JSON body");
  }
}

export function sendJson(res, status, payload) {
  // The caller may have hung up while the model was running.
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * The route handler. `api` is the plugin API (only `api.runtime.llm.complete` is
 * used). Always answers, so it returns true:
 *
 *   200 { text, provider, model, usage }  the model answered (text is non-empty)
 *   400 { error }                         malformed request
 *   405 { error }                         not a POST
 *   501 { error }                         this openclaw has no completion runtime
 *   502 { error }                         the model call failed or returned no text
 *   504 { error }                         the model call ran past timeout_ms
 */
export function createCompleteHandler(api) {
  return async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    if (typeof api?.runtime?.llm?.complete !== "function") {
      // Tell the caller now, so it falls back instead of waiting on a model call
      // that cannot happen.
      sendJson(res, 501, { error: "llm completion runtime unavailable" });
      return true;
    }
    let parsed;
    try {
      parsed = parseCompleteRequest(await readJsonBody(req));
    } catch (err) {
      sendJson(res, 400, { error: errorMessage(err) });
      return true;
    }
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
      return true;
    }

    const { timeoutMs, ...params } = parsed.params;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // The caller gave up (its own timeout fired): stop paying for the call.
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      const result = await api.runtime.llm.complete({ ...params, signal: controller.signal });
      const reply = toCompleteResponse(result);
      // A provider error does not always throw: the completion can come back as
      // an empty message instead (verified on 2026.5.20 against a provider
      // answering 404). Report it as the failure it is.
      if (!reply.text.trim()) {
        sendJson(res, 502, { error: "model returned no text" });
      } else {
        sendJson(res, 200, reply);
      }
    } catch (err) {
      sendJson(res, controller.signal.aborted ? 504 : 502, { error: errorMessage(err) });
    } finally {
      clearTimeout(timer);
    }
    return true;
  };
}
