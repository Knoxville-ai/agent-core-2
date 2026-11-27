import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { isPlatformForwardAuth } from "../openclaw/gateway-auth.js";
import { HttpError } from "./auth.js";
import { SESSION_STAMP_PARAM, sessionHeaders } from "./session-policy.js";

/**
 * The console MCP, through the shim (SEC-023).
 *
 * The console limits an agent's console tools by the session a call comes
 * from, read from `X-Agent-Session-Conversation` / `X-Agent-Session-Task` on
 * every MCP request (console CONTRACT.md). openclaw's MCP client sends the
 * same fixed headers for every session, so it is pointed here instead of at
 * the console, with the console MCP forward token from openclaw.json
 * (../openclaw/gateway-auth.ts platformForwardToken). This route adds the
 * agent's platform token and forwards the request unchanged otherwise,
 * streaming the answer back.
 *
 * Session headers come only from a ticket: when the knox-session-policy plugin
 * asks /internal/tool-policy (plugin loopback token, which no exec command can
 * present) about a platform tool call it may make, the shim issues a
 * single-use ticket bound to that session and tool, and the plugin stamps it
 * onto the call (`_knox_session`). Here the ticket is taken off and redeemed
 * for the session's headers. The forward token alone therefore can't name a
 * session: a request with no ticket goes through with no session headers
 * (initialize, tools/list — judged by the console as a call that names no
 * session, exactly as a direct call with the platform token is), and one with
 * a ticket that isn't live is refused.
 *
 * `POST /internal/platform-mcp/github/git-credential` forwards the git
 * credential helper's request (docker/git-credential-env reads this URL and
 * the forward token from openclaw.json) to the console's GitHub connector.
 */

export const PLATFORM_MCP_FORWARD_PATH = "/internal/platform-mcp";

/** Console paths below the MCP URL that the forward route may reach. */
const FORWARD_SUBPATHS = new Set(["/github/git-credential"]);

/** True for a path this route serves. */
export function isPlatformMcpForwardPath(path: string): boolean {
  if (path === PLATFORM_MCP_FORWARD_PATH) return true;
  if (!path.startsWith(`${PLATFORM_MCP_FORWARD_PATH}/`)) return false;
  return FORWARD_SUBPATHS.has(path.slice(PLATFORM_MCP_FORWARD_PATH.length));
}

/** Whether openclaw reaches the console MCP through the shim (AGENT_PLATFORM_MCP_FORWARD, default on). */
export function platformMcpForwarded(
  env: Pick<AgentEnv, "PLATFORM_MCP_URL" | "PLATFORM_API_TOKEN" | "AGENT_PLATFORM_MCP_FORWARD">,
): boolean {
  return Boolean(env.PLATFORM_MCP_URL && env.PLATFORM_API_TOKEN && env.AGENT_PLATFORM_MCP_FORWARD !== false);
}

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const TICKET_TTL_MS = 10 * 60_000;
const MAX_TICKETS = 5_000;

/** Request headers passed through to the console (the MCP transport's own). */
const PASS_REQUEST_HEADERS = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
/** Response headers passed back. */
const PASS_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control", "www-authenticate", "retry-after"];

/**
 * Single-use session tickets: issued to the session-policy plugin for one
 * platform tool call, redeemed here for that call's session.
 */
export class SessionTickets {
  private readonly tickets = new Map<string, { sessionKey: string; tool: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A ticket for one call of `tool` (the console's own tool name) in this session. */
  issue(sessionKey: string, tool: string): string {
    const now = this.now();
    if (this.tickets.size >= MAX_TICKETS) {
      for (const [k, t] of this.tickets) if (t.expiresAt <= now) this.tickets.delete(k);
      while (this.tickets.size >= MAX_TICKETS) this.tickets.delete(this.tickets.keys().next().value!);
    }
    const ticket = `kst_${randomBytes(18).toString("base64url")}`;
    this.tickets.set(ticket, { sessionKey, tool: tool.toLowerCase(), expiresAt: now + TICKET_TTL_MS });
    return ticket;
  }

  /** The session a ticket was issued for, once, for this tool; null otherwise. */
  redeem(ticket: string, tool: unknown): string | null {
    const t = this.tickets.get(ticket);
    if (!t) return null;
    this.tickets.delete(ticket);
    if (t.expiresAt <= this.now()) return null;
    if (typeof tool !== "string" || tool.toLowerCase() !== t.tool) return null;
    return t.sessionKey;
  }
}

export interface ForwardDeps {
  env: Pick<AgentEnv, "PLATFORM_MCP_URL" | "PLATFORM_API_TOKEN" | "OPENCLAW_GATEWAY_TOKEN">;
  tickets: SessionTickets;
  /** The console session a session key names. */
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

export interface UnstampedCall {
  /** The JSON-RPC id of the stamped call (for an error answer). */
  id: unknown;
  ticket: string | null;
  /** The console tool the call names. */
  tool: unknown;
}

/**
 * Take the runtime's stamp off every tools/call in a JSON-RPC body (a message
 * or a batch). Returns each stamped call and the body to forward (the original
 * bytes when nothing was stamped or it isn't JSON).
 */
export function unstampBody(raw: Buffer): { calls: UnstampedCall[]; body: Buffer } {
  if (raw.length === 0) return { calls: [], body: raw };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return { calls: [], body: raw };
  }
  const calls: UnstampedCall[] = [];
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  for (const m of messages) {
    const msg = m as { id?: unknown; params?: { name?: unknown; arguments?: unknown } } | null;
    const args = msg?.params?.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) continue;
    if (!(SESSION_STAMP_PARAM in (args as Record<string, unknown>))) continue;
    const stamp = (args as Record<string, unknown>)[SESSION_STAMP_PARAM];
    delete (args as Record<string, unknown>)[SESSION_STAMP_PARAM];
    calls.push({ id: msg?.id ?? null, ticket: typeof stamp === "string" && stamp.trim() ? stamp.trim() : null, tool: msg?.params?.name });
  }
  return { calls, body: calls.length > 0 ? Buffer.from(JSON.stringify(parsed), "utf8") : raw };
}

export async function handlePlatformMcpForward(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ForwardDeps,
  path: string = PLATFORM_MCP_FORWARD_PATH,
): Promise<void> {
  const { env } = deps;
  if (!isPlatformForwardAuth(req.headers.authorization, env)) throw new HttpError(401, "invalid forward token");
  if (!env.PLATFORM_MCP_URL || !env.PLATFORM_API_TOKEN) throw new HttpError(503, "platform MCP not configured");
  if (!isPlatformMcpForwardPath(path)) throw new HttpError(404, "not found");
  const subpath = path.slice(PLATFORM_MCP_FORWARD_PATH.length);
  const method = (req.method ?? "GET").toUpperCase();
  if (subpath ? method !== "POST" : !["GET", "POST", "DELETE"].includes(method)) {
    throw new HttpError(405, "method not allowed");
  }

  let body: Buffer | undefined;
  let session = { conversationId: null as string | null, taskId: null as string | null };
  if (method === "POST") {
    const raw = await readRaw(req);
    if (subpath) {
      body = raw;
    } else {
      const unstamped = unstampBody(raw);
      body = unstamped.body;
      let sessionKey: string | null = null;
      for (const call of unstamped.calls) {
        const key = call.ticket ? deps.tickets.redeem(call.ticket, call.tool) : null;
        if (!key || (sessionKey && key !== sessionKey)) {
          log.warn("platform MCP forward: session ticket refused", { tool: String(call.tool) });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: call.id,
              error: { code: -32602, message: "This call's session couldn't be confirmed, so it wasn't sent. Try again." },
            }),
          );
          return;
        }
        sessionKey = key;
      }
      if (sessionKey) session = deps.resolveSession(sessionKey);
    }
  }

  const headers: Record<string, string> = {};
  for (const name of PASS_REQUEST_HEADERS) {
    const v = req.headers[name];
    if (typeof v === "string" && v) headers[name] = v;
  }
  Object.assign(headers, sessionHeaders(session));
  headers.authorization = `Bearer ${env.PLATFORM_API_TOKEN}`;

  const target = subpath ? `${env.PLATFORM_MCP_URL.replace(/\/+$/, "")}${subpath}` : env.PLATFORM_MCP_URL;
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  let upstream: Response;
  try {
    upstream = await (deps.fetchImpl ?? fetch)(target, {
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
