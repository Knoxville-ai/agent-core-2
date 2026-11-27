import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { HttpError } from "./auth.js";
import { handlePlatformMcpForward, unstampBody } from "./platform-mcp-forward.js";

const GATEWAY = "gateway-token-0123456789";
const PLATFORM = "knox_agent_secret";

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
      seen.push({ method: req.method ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
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

async function shim(consoleUrl: string): Promise<string> {
  return listen(
    createServer((req, res) => {
      handlePlatformMcpForward(req, res, {
        env: { PLATFORM_MCP_URL: consoleUrl, PLATFORM_API_TOKEN: PLATFORM, OPENCLAW_GATEWAY_TOKEN: GATEWAY },
        resolveSession: (key) =>
          key === "webchat:c0ffee00-0000-4000-8000-000000000001"
            ? { conversationId: "c0ffee00-0000-4000-8000-000000000001", taskId: null }
            : key.startsWith("task:")
              ? { conversationId: null, taskId: key.slice(5) }
              : { conversationId: null, taskId: null },
      }).catch((err) => {
        res.writeHead(err instanceof HttpError ? err.status : 500);
        res.end();
      });
    }),
  );
}

const call = (args: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_my_tasks", arguments: args } });

describe("console MCP forwarder", () => {
  it("adds the session headers and the platform token, and takes the runtime's stamp off", async () => {
    const upstream = await fakeConsole();
    const base = await shim(upstream.url);
    const res = await fetch(`${base}/internal/platform-mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GATEWAY}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Protocol-Version": "2025-06-18",
      },
      body: call({ limit: 5, _knox_session: "webchat:c0ffee00-0000-4000-8000-000000000001" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBe("s-1");
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    const got = upstream.seen[0]!;
    expect(got.headers["x-agent-session-conversation"]).toBe("c0ffee00-0000-4000-8000-000000000001");
    expect(got.headers["x-agent-session-task"]).toBeUndefined();
    expect(got.headers.authorization).toBe(`Bearer ${PLATFORM}`);
    expect(got.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(JSON.parse(got.body).params.arguments).toEqual({ limit: 5 });
  });

  it("names a task session with the task header", async () => {
    const upstream = await fakeConsole();
    const base = await shim(upstream.url);
    await fetch(`${base}/internal/platform-mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${GATEWAY}`, "Content-Type": "application/json" },
      body: call({ _knox_session: "task:7a1e0000-0000-4000-8000-000000000002" }),
    });
    expect(upstream.seen[0]!.headers["x-agent-session-task"]).toBe("7a1e0000-0000-4000-8000-000000000002");
  });

  it("passes unstamped requests through untouched and streams SSE answers", async () => {
    const upstream = await fakeConsole("sse");
    const base = await shim(upstream.url);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const res = await fetch(`${base}/internal/platform-mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${GATEWAY}`, "Content-Type": "application/json" },
      body,
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toContain('"result":{"ok":1}');
    expect(upstream.seen[0]!.body).toBe(body);
    expect(upstream.seen[0]!.headers["x-agent-session-conversation"]).toBeUndefined();
  });

  it("refuses a caller without the gateway token", async () => {
    const upstream = await fakeConsole();
    const base = await shim(upstream.url);
    for (const auth of [undefined, `Bearer ${PLATFORM}`, "Bearer nope"]) {
      const res = await fetch(`${base}/internal/platform-mcp`, {
        method: "POST",
        headers: { ...(auth ? { Authorization: auth } : {}), "Content-Type": "application/json" },
        body: call({ _knox_session: "webchat:c0ffee00-0000-4000-8000-000000000001" }),
      });
      expect(res.status).toBe(401);
    }
    expect(upstream.seen).toHaveLength(0);
  });
});

describe("unstampBody", () => {
  it("strips the stamp from every message of a batch and keeps the first session", () => {
    const raw = Buffer.from(
      JSON.stringify([
        { method: "tools/call", params: { arguments: { a: 1, _knox_session: "webchat:x" } } },
        { method: "tools/call", params: { arguments: { _knox_session: "webchat:y" } } },
      ]),
    );
    const out = unstampBody(raw);
    expect(out.sessionKey).toBe("webchat:x");
    expect(JSON.parse(out.body.toString())).toEqual([
      { method: "tools/call", params: { arguments: { a: 1 } } },
      { method: "tools/call", params: { arguments: {} } },
    ]);
  });

  it("leaves bodies it can't read alone", () => {
    const raw = Buffer.from("not json");
    expect(unstampBody(raw)).toEqual({ sessionKey: null, body: raw });
  });
});
