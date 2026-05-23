import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

import WebSocket from "ws";

import { log } from "../log.js";

/**
 * Minimal WebSocket client for the openclaw Gateway protocol.
 *
 * Protocol (from docs/gateway/protocol.md):
 *   - Transport: WS, JSON text frames.
 *   - Handshake: server sends `connect.challenge`; client replies with
 *     a `connect` request; server returns `hello-ok`.
 *   - Requests:  { type: "req", id, method, params }
 *   - Responses: { type: "res", id, ok, payload }
 *   - Events:    { type: "event", event, payload, seq }
 *
 * Auth: gateway.auth.token in openclaw.json. Per the docs the WS upgrade
 * timeout is `handshakeTimeoutMs`, suggesting auth happens on upgrade. We
 * send it as `Authorization: Bearer <token>` AND include it in the connect
 * request body for belt-and-suspenders compatibility — the docs were
 * incomplete on the exact field name (see comment in shim/auth.ts). If
 * deploy testing shows the token field has a different name (e.g. `auth`,
 * `bearer`), adjust `connect()` below.
 */

type Pending = {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export interface SessionEvent {
  event: string;
  payload: Record<string, unknown>;
  seq?: number;
}

export class GatewayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private ready = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {
    super();
  }

  async connectWithRetry(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      try {
        await this.connect();
        return;
      } catch (err) {
        lastErr = err;
        await sleep(500);
      }
    }
    throw new Error(
      `failed to connect to openclaw gateway at ${this.url}: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        headers: { Authorization: `Bearer ${this.token}` },
        handshakeTimeout: 5_000,
      });

      const onOpenError = (err: Error) => {
        ws.removeAllListeners();
        reject(err);
      };
      ws.once("error", onOpenError);

      ws.on("open", () => {
        ws.removeListener("error", onOpenError);
        this.ws = ws;
        this.attachHandlers(ws, resolve, reject);
      });
    });
  }

  private attachHandlers(
    ws: WebSocket,
    onReady: () => void,
    onReadyError: (e: Error) => void,
  ): void {
    let helloSeen = false;

    ws.on("message", (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        log.warn("gateway: non-json frame", { len: raw.length });
        return;
      }
      const type = msg.type as string | undefined;

      if (!helloSeen) {
        if (type === "connect.challenge") {
          // Reply with a connect request including the token.
          const id = this.allocId();
          ws.send(
            JSON.stringify({
              type: "req",
              id,
              method: "connect",
              params: {
                token: this.token,
                client: { name: "knoxville-shim", version: "0.3.0" },
                challenge: msg.payload ?? msg.nonce ?? null,
              },
            }),
          );
          return;
        }
        if (type === "res") {
          const ok = msg.ok as boolean | undefined;
          if (ok === false) {
            onReadyError(
              new Error(
                `connect rejected: ${JSON.stringify(msg.payload ?? msg)}`,
              ),
            );
            ws.close();
            return;
          }
          // Some servers send hello-ok as a typed frame (below). Tolerate
          // either shape: any successful res to our connect counts as ready.
        }
        if (type === "hello-ok" || type === "res") {
          helloSeen = true;
          this.ready = true;
          onReady();
          this.emit("ready");
          return;
        }
        return;
      }

      this.dispatchPostHandshake(msg);
    });

    ws.on("error", (err: Error) => {
      log.error("gateway ws error", { err: err.message });
      this.emit("error", err);
    });
    ws.on("close", (code, reason) => {
      log.warn("gateway ws closed", { code, reason: reason.toString("utf8") });
      this.ready = false;
      this.ws = null;
      this.failAllPending(new Error(`gateway connection closed (${code})`));
      this.emit("close");
    });
  }

  private dispatchPostHandshake(msg: Record<string, unknown>): void {
    const type = msg.type as string | undefined;
    if (type === "res") {
      const id = msg.id as string | undefined;
      if (!id) return;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.ok === false) {
        p.reject(new Error(`gateway error: ${JSON.stringify(msg.payload)}`));
      } else {
        p.resolve(msg.payload);
      }
      return;
    }
    if (type === "event") {
      const event = msg.event as string;
      const payload = (msg.payload ?? {}) as Record<string, unknown>;
      const seq = msg.seq as number | undefined;
      this.emit("event", { event, payload, seq } as SessionEvent);
      return;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || !this.ready) {
        reject(new Error("gateway not ready"));
        return;
      }
      const id = this.allocId();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (p) => resolve(p as T),
        reject,
        timer,
      });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    this.failAllPending(new Error("gateway client closing"));
  }

  private failAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private allocId(): string {
    return `req-${this.nextId++}`;
  }
}
