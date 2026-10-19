import { randomUUID } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";

import { log } from "../log.js";
import { parseRelayMap, type ProcessEvents } from "./process-events.js";

/**
 * The MCP relay: a loopback pass-through in front of MCP URLs that skills call
 * from scripts (console phase 5, spec DECISIONS 64).
 *
 * Why it exists
 * -------------
 * openclaw's tool hooks see the MCP servers openclaw itself calls, but not a
 * skill script that talks MCP on its own: drivethru-odoo runs `python3
 * scripts/...` through `exec` and calls the Odoo MCP server at ODOO_MCP_URL with
 * the `mcp` SDK. Those writes would be invisible to the process map. The relay
 * gives the gateway (and so every skill subprocess) a loopback ODOO_MCP_URL;
 * each request goes on to the real URL unchanged, and each `tools/call` to a
 * declared write tool is guarded before it is forwarded and reported after its
 * response comes back. The skill can't tell the difference.
 *
 * Posture
 * -------
 *   - Transparent. Requests and responses are forwarded byte for byte (only
 *     hop-by-hop headers and accept-encoding are dropped, so the response can
 *     be read). Session headers, SSE streams and status codes pass through.
 *   - Fail open on observation. A body that doesn't parse, a response that
 *     isn't JSON-RPC or a report that fails changes nothing about the call.
 *     The guard blocks only on the console's "refused", which it sends only
 *     while it enforces (AGENT_WRITE_GUARD).
 *   - Loopback only: bound to 127.0.0.1, like the cost proxy.
 *   - Kill switch: PROCESS_EVENTS=false, or an empty PROCESS_EVENTS_RELAY.
 *     If the relay can't bind, the gateway gets the real URLs.
 *
 * Only streamable-HTTP MCP is observed (a request and its response on one
 * POST). Anything else (the GET notification stream, the legacy SSE
 * transport) is forwarded without being observed.
 */

const HOP_HEADERS = new Set([
  "host",
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "accept-encoding",
  "content-length",
]);
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_OBSERVED_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface McpRelayHandle {
  /** The env values to give the gateway in place of the real URLs. */
  readonly envOverrides: Record<string, string>;
  close(): Promise<void>;
}

interface Route {
  prefix: string;
  upstream: URL;
  surface: string;
}

interface Tracked {
  id: string | number;
  tool: string;
  args: Record<string, unknown>;
  callId: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The `tools/call` requests in a JSON-RPC body (one message or a batch). */
export function toolCallsIn(body: unknown): Array<{ id: string | number; tool: string; args: Record<string, unknown> }> {
  const messages = Array.isArray(body) ? body : [body];
  const out = [];
  for (const m of messages) {
    if (!isRecord(m) || m.method !== "tools/call" || !isRecord(m.params)) continue;
    const id = m.id;
    const name = m.params.name;
    if ((typeof id !== "string" && typeof id !== "number") || typeof name !== "string") continue;
    out.push({ id, tool: name, args: isRecord(m.params.arguments) ? m.params.arguments : {} });
  }
  return out;
}

/** JSON-RPC messages in a response body: JSON (one or a batch) or a complete SSE stream's data frames. */
export function messagesIn(contentType: string, text: string): Record<string, unknown>[] {
  const parse = (s: string): Record<string, unknown>[] => {
    try {
      const v: unknown = JSON.parse(s);
      return (Array.isArray(v) ? v : [v]).filter(isRecord);
    } catch {
      return [];
    }
  };
  if (!contentType.includes("text/event-stream")) return parse(text);
  const out: Record<string, unknown>[] = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) out.push(...parse(data));
  }
  return out;
}

function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined && !HOP_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error("request too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function refusal(id: string | number, reason: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { isError: true, content: [{ type: "text", text: `Refused by the platform: ${reason}` }] },
  });
}

export class McpRelay {
  private readonly routes: Route[];

  constructor(routes: Array<{ name: string; upstream: string; surface: string }>, private readonly events: ProcessEvents) {
    this.routes = routes.map((r) => ({ prefix: `/${r.name.toLowerCase()}`, upstream: new URL(r.upstream), surface: r.surface }));
  }

  /** The upstream URL for a relay path, or null when no route matches. */
  upstreamFor(path: string): { route: Route; url: URL } | null {
    const u = new URL(path, "http://relay.invalid");
    for (const route of this.routes) {
      if (u.pathname !== route.prefix && !u.pathname.startsWith(`${route.prefix}/`)) continue;
      const url = new URL(route.upstream.href);
      const rest = u.pathname.slice(route.prefix.length);
      if (rest) url.pathname = `${url.pathname.replace(/\/$/, "")}${rest}`;
      if (u.search) url.search = u.search;
      return { route, url };
    }
    return null;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = this.upstreamFor(req.url ?? "/");
    if (!target) {
      res.writeHead(404).end();
      return;
    }
    const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : Buffer.alloc(0);

    // Which declared writes this request carries, and whether each may run.
    let tracked: Tracked[] = [];
    if (body.length && String(req.headers["content-type"] ?? "").includes("json")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        parsed = undefined;
      }
      for (const call of toolCallsIn(parsed)) {
        if (!(await this.events.declaredSurface({ surface: target.route.surface, tool: call.tool }))) continue;
        tracked.push({ ...call, callId: `relay:${randomUUID()}` });
      }
      if (tracked.length === 1 && !Array.isArray(parsed)) {
        const verdict = await this.events.guard({ surface: target.route.surface, tool: tracked[0]!.tool }, tracked[0]!.args);
        if (!verdict.allowed) {
          res.writeHead(200, { "content-type": "application/json" }).end(refusal(tracked[0]!.id, verdict.reason ?? "refused"));
          return;
        }
      } else {
        // A batch: guarded for the log only; it is forwarded whole.
        for (const t of tracked) await this.events.guard({ surface: target.route.surface, tool: t.tool }, t.args);
      }
    }

    const send = target.url.protocol === "https:" ? httpsRequest : httpRequest;
    const headers = forwardHeaders(req.headers);
    // Sent with a length, not chunked: some servers refuse chunked request bodies.
    if (body.length) headers["content-length"] = String(body.length);
    const upstream = send(target.url, { method: req.method, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, forwardHeaders(up.headers));
      const contentType = String(up.headers["content-type"] ?? "");
      let seen = "";
      let observing = tracked.length > 0;
      const report = (final: boolean) => {
        if (!observing) return;
        for (const m of messagesIn(contentType, seen)) {
          const i = tracked.findIndex((t) => t.id === m.id);
          if (i < 0) continue;
          const t = tracked[i]!;
          tracked = tracked.filter((_, j) => j !== i);
          const result = isRecord(m.result) ? m.result : undefined;
          void this.events.record({
            surface: target.route.surface,
            tool: t.tool,
            args: t.args,
            result,
            isError: m.error !== undefined || result?.isError === true,
            callId: t.callId,
            finishedAt: new Date().toISOString(),
          });
        }
        if (final || tracked.length === 0) observing = false;
      };
      up.on("data", (chunk: Buffer) => {
        res.write(chunk);
        if (!observing) return;
        seen += chunk.toString("utf8");
        if (seen.length > MAX_OBSERVED_RESPONSE_BYTES) {
          observing = false;
          log.warn("mcp relay: response too large to observe", { route: target.route.prefix });
          return;
        }
        // An SSE response can stay open after the answer: report as frames complete.
        if (contentType.includes("text/event-stream") && /\r?\n\r?\n/.test(seen)) report(false);
      });
      up.on("end", () => {
        report(true);
        res.end();
      });
      up.on("error", () => res.destroy());
    });
    upstream.on("error", (err) => {
      log.warn("mcp relay: upstream request failed", { route: target.route.prefix, err: String(err) });
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream unavailable" }));
    });
    req.on("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });
    upstream.end(body);
  }
}

/**
 * Start the relay for the PROCESS_EVENTS_RELAY env vars that hold an http(s)
 * URL. Null when there are none or it can't bind: the gateway then gets the
 * real URLs.
 */
export async function startMcpRelay(
  relayMap: string,
  env: Record<string, string | undefined>,
  events: ProcessEvents,
): Promise<McpRelayHandle | null> {
  const routes = parseRelayMap(relayMap)
    .map(([name, surface]) => ({ name, surface, upstream: env[name] ?? "" }))
    .filter((r) => /^https?:\/\//.test(r.upstream));
  if (!routes.length) return null;
  const relay = new McpRelay(routes, events);
  const server: Server = createServer((req, res) => {
    relay.handle(req, res).catch((err) => {
      log.warn("mcp relay: request failed", { err: String(err) });
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "relay error" }));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
  } catch (err) {
    log.warn("mcp relay: could not bind; skills call MCP directly", { err: String(err) });
    return null;
  }
  const { port } = server.address() as AddressInfo;
  const envOverrides = Object.fromEntries(routes.map((r) => [r.name, `http://127.0.0.1:${port}/${r.name.toLowerCase()}`]));
  log.info("mcp relay listening", { port, relayed: routes.map((r) => `${r.name}=${r.surface}`) });
  return {
    envOverrides,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
