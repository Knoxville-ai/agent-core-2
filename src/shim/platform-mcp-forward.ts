import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { HttpError } from "./auth.js";
import { requireGatewayToken } from "./routes-files.js";
import { SESSION_STAMP_PARAM, sessionHeaders } from "./session-policy.js";

/**
 * The console MCP, through the shim (SEC-023).
 *
 * The console limits an agent's console tools by the session a call comes
 * from, read from `X-Agent-Session-Conversation` / `X-Agent-Session-Task` on
 * every MCP request (console CONTRACT.md). openclaw's MCP client sends the
 * same fixed headers for every session, so it is pointed here instead of at
 * the console, with the gateway token: the knox-session-policy plugin stamps
 * each platform tool call with the session it runs in (`_knox_session`), and
 * this route takes that stamp off, adds the session headers and the agent's
 * platform token, and forwards the request unchanged otherwise, streaming the
 * answer back. Requests that carry no stamp (initialize, tools/list) go
 * through without session headers.
 */

export const PLATFORM_MCP_FORWARD_PATH = "/internal/platform-mcp";

const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Request headers passed through to the console (the MCP transport's own). */
const PASS_REQUEST_HEADERS = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
/** Response headers passed back. */
const PASS_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control", "www-authenticate", "retry-after"];

export interface ForwardDeps {
  env: Pick<AgentEnv, "PLATFORM_MCP_URL" | "PLATFORM_API_TOKEN" | "OPENCLAW_GATEWAY_TOKEN">;
  /** The console session a stamped session key names. */
  resolveSession(sessionKey: string): { conversationId: string | null; taskId: string | null };
  fetchImpl?: typeof fetch;
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    received += buf.length;
    if (received > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Take the runtime's session stamp off every tools/call in a JSON-RPC body (a
 * message or a batch). Returns the first session key found and the body to
 * forward (the original bytes when nothing was stamped or it isn't JSON).
 */
export function unstampBody(raw: Buffer): { sessionKey: string | null; body: Buffer } {
  if (raw.length === 0) return { sessionKey: null, body: raw };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return { sessionKey: null, body: raw };
  }
  let sessionKey: string | null = null;
  let changed = false;
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  for (const m of messages) {
    const params = (m as { method?: unknown; params?: { arguments?: unknown } } | null)?.params;
    const args = params?.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) continue;
    if (!(SESSION_STAMP_PARAM in (args as Record<string, unknown>))) continue;
    const stamp = (args as Record<string, unknown>)[SESSION_STAMP_PARAM];
    delete (args as Record<string, unknown>)[SESSION_STAMP_PARAM];
    changed = true;
    if (!sessionKey && typeof stamp === "string" && stamp.trim()) sessionKey = stamp.trim();
  }
  return { sessionKey, body: changed ? Buffer.from(JSON.stringify(parsed), "utf8") : raw };
}

export async function handlePlatformMcpForward(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ForwardDeps,
): Promise<void> {
  const { env } = deps;
  requireGatewayToken(req.headers.authorization, env as AgentEnv);
  if (!env.PLATFORM_MCP_URL || !env.PLATFORM_API_TOKEN) throw new HttpError(503, "platform MCP not configured");
  const method = (req.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "DELETE"].includes(method)) throw new HttpError(405, "method not allowed");

  let body: Buffer | undefined;
  let session = { conversationId: null as string | null, taskId: null as string | null };
  if (method === "POST") {
    const raw = await readRaw(req);
    const unstamped = unstampBody(raw);
    body = unstamped.body;
    if (unstamped.sessionKey) session = deps.resolveSession(unstamped.sessionKey);
  }

  const headers: Record<string, string> = {};
  for (const name of PASS_REQUEST_HEADERS) {
    const v = req.headers[name];
    if (typeof v === "string" && v) headers[name] = v;
  }
  Object.assign(headers, sessionHeaders(session));
  headers.authorization = `Bearer ${env.PLATFORM_API_TOKEN}`;

  const abort = new AbortController();
  res.on("close", () => abort.abort());
  let upstream: Response;
  try {
    upstream = await (deps.fetchImpl ?? fetch)(env.PLATFORM_MCP_URL, {
      method,
      headers,
      ...(body && method === "POST" ? { body } : {}),
      signal: abort.signal,
    });
  } catch (err) {
    log.warn("platform MCP forward failed", { err: String(err) });
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "platform MCP unreachable" }));
    }
    return;
  }

  const out: Record<string, string> = {};
  for (const name of PASS_RESPONSE_HEADERS) {
    const v = upstream.headers.get(name);
    if (v) out[name] = v;
  }
  res.writeHead(upstream.status, out);
  if (!upstream.body) {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>);
  stream.on("error", () => {
    try {
      res.end();
    } catch {
      /* already closed */
    }
  });
  stream.pipe(res);
}
