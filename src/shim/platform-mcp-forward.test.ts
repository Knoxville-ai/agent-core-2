import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { gatewayAuthToken, platformForwardToken, pluginLoopbackToken } from "../openclaw/gateway-auth.js";
import { HttpError } from "./auth.js";
import { handlePlatformMcpForward, SessionTickets, unstampBody } from "./platform-mcp-forward.js";

const CONSOLE_TOKEN = "console-gateway-token-0123456789";
const PLATFORM = "knox_agent_secret";
const ENV = { OPENCLAW_GATEWAY_TOKEN: CONSOLE_TOKEN };
const FORWARD = platformForwardToken(ENV);
const CONV = "c0ffee00-0000-4000-8000-000000000001";
const TASK = "7a1e0000-0000-4000-8000-000000000002";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface Seen {
  method: string;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

/** A stand-in console MCP that records what it got and answers as asked. */
async function fakeConsole(respond: "json" | "sse" = "json"): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const url = await listen(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      seen.push({ method: req.method ?? "", url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (req.url?.endsWith("/github/git-credential")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("username=x-access-token\npassword=app-token\n");
        return;
      }
      if (respond === "sse") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Mcp-Session-Id": "s-1" });
        res.write('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":1}}\n\n');
        setTimeout(() => res.end(), 10);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "s-1" });
      res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    }),
  );
  return { url: `${url}/api/mcp`, seen };
}

async function shim(consoleUrl: string, tickets = new SessionTickets()): Promise<string> {
  return listen(
    createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      handlePlatformMcpForward(
        req,
        res,
        {
          env: { ...ENV, PLATFORM_MCP_URL: consoleUrl, PLATFORM_API_TOKEN: PLATFORM },
          tickets,
          resolveSession: (key) =>
            key.startsWith("webchat:")
              ? { conversationId: key.slice(8), taskId: null }
              : key.startsWith("task:")
                ? { conversationId: null, taskId: key.slice(5) }
                : { conversationId: null, taskId: null },
        },
        path,
      ).catch((err) => {
        res.writeHead(err instanceof HttpError ? err.status : 500);
        res.end();
      });
    }),
  );
}

const call = (args: Record<string, unknown>, name = "list_my_tasks") =>
  JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });

const post = (base: string, body: string, auth = FORWARD, path = "/internal/platform-mcp") =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Protocol-Version": "2025-06-18",
    },
    body,
  });

describe("console MCP forwarder", () => {
  it("redeems the plugin's ticket for the session headers, adds the platform token, takes the stamp off", async () => {
    const upstream = await fakeConsole();
    const tickets = new SessionTickets();
    const base = await shim(upstream.url, tickets);
    const ticket = tickets.issue(`webchat:${CONV}`, "list_my_tasks");
    const res = await post(base, call({ limit: 5, _knox_session: ticket }));
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBe("s-1");
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    const got = upstream.seen[0]!;
    expect(got.headers["x-agent-session-conversation"]).toBe(CONV);
    expect(got.headers["x-agent-session-task"]).toBeUndefined();
    expect(got.headers.authorization).toBe(`Bearer ${PLATFORM}`);
    expect(got.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(JSON.parse(got.body).params.arguments).toEqual({ limit: 5 });
  });

  it("names a task session with the task header", async () => {
    const upstream = await fakeConsole();
    const tickets = new SessionTickets();
    const base = await shim(upstream.url, tickets);
    await post(base, call({ _knox_session: tickets.issue(`task:${TASK}`, "list_my_tasks") }));
    expect(upstream.seen[0]!.headers["x-agent-session-task"]).toBe(TASK);
  });

  it("the forward token alone can't pick a session: a session key, a used, made-up or other-tool ticket is refused", async () => {
    const upstream = await fakeConsole();
    const tickets = new SessionTickets();
    const base = await shim(upstream.url, tickets);
    const used = tickets.issue(`webchat:${CONV}`, "list_my_tasks");
    await post(base, call({ _knox_session: used }));
    expect(upstream.seen).toHaveLength(1);
    for (const stamp of [`webchat:${CONV}`, used, "kst_made_up", tickets.issue(`webchat:${CONV}`, "recall")]) {
      const res = await post(base, call({ _knox_session: stamp }));
      const body = (await res.json()) as { id: unknown; error?: { message: string } };
      expect(body.id).toBe(7);
      expect(body.error?.message).toMatch(/couldn't be confirmed/);
    }
    expect(upstream.seen).toHaveLength(1);
  });

  it("passes unstamped requests through untouched, with no session headers, and streams SSE answers", async () => {
    const upstream = await fakeConsole("sse");
    const base = await shim(upstream.url);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const res = await post(base, body);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toContain('"result":{"ok":1}');
    expect(upstream.seen[0]!.body).toBe(body);
    expect(upstream.seen[0]!.headers["x-agent-session-conversation"]).toBeUndefined();
  });

  it("accepts only the forward token: not the console's, the gateway auth or the plugin loopback token", async () => {
    const upstream = await fakeConsole();
    const base = await shim(upstream.url);
    for (const auth of ["", PLATFORM, CONSOLE_TOKEN, gatewayAuthToken(ENV), pluginLoopbackToken(), "nope"]) {
      const res = await post(base, call({}), auth);
      expect(res.status, auth).toBe(401);
    }
    expect(upstream.seen).toHaveLength(0);
  });

  it("forwards the git credential helper's request to the console's GitHub connector, and nothing else", async () => {
    const upstream = await fakeConsole();
    const base = await shim(upstream.url);
    const res = await post(
      base,
      "protocol=https\nhost=github.com\npath=acme/app.git\n",
      FORWARD,
      "/internal/platform-mcp/github/git-credential",
    );
    expect(await res.text()).toContain("password=app-token");
    expect(upstream.seen[0]!.url).toBe("/api/mcp/github/git-credential");
    expect(upstream.seen[0]!.headers.authorization).toBe(`Bearer ${PLATFORM}`);
    expect(upstream.seen[0]!.body).toContain("path=acme/app.git");
    const other = await post(base, "{}", FORWARD, "/internal/platform-mcp/quickbooks/x");
    expect(other.status).toBe(404);
  });
});

describe("SessionTickets", () => {
  it("are single use, bound to a tool, and expire", () => {
    let now = 0;
    const t = new SessionTickets(() => now);
    const a = t.issue("webchat:c", "Recall");
    expect(t.redeem(a, "recall")).toBe("webchat:c");
    expect(t.redeem(a, "recall")).toBeNull();
    expect(t.redeem(t.issue("webchat:c", "recall"), "remember")).toBeNull();
    const old = t.issue("webchat:c", "recall");
    now += 11 * 60_000;
    expect(t.redeem(old, "recall")).toBeNull();
  });
});

describe("unstampBody", () => {
  it("strips the stamp from every message of a batch", () => {
    const raw = Buffer.from(
      JSON.stringify([
        { id: 1, method: "tools/call", params: { name: "a", arguments: { a: 1, _knox_session: "kst_x" } } },
        { id: 2, method: "tools/call", params: { name: "b", arguments: { _knox_session: "kst_y" } } },
      ]),
    );
    const out = unstampBody(raw);
    expect(out.calls).toEqual([
      { id: 1, ticket: "kst_x", tool: "a" },
      { id: 2, ticket: "kst_y", tool: "b" },
    ]);
    expect(JSON.parse(out.body.toString())).toEqual([
      { id: 1, method: "tools/call", params: { name: "a", arguments: { a: 1 } } },
      { id: 2, method: "tools/call", params: { name: "b", arguments: {} } },
    ]);
  });

  it("leaves bodies it can't read alone", () => {
    const raw = Buffer.from("not json");
    expect(unstampBody(raw)).toEqual({ calls: [], body: raw });
  });
});
