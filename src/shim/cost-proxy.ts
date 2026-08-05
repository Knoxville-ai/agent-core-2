import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Writable } from "node:stream";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import type { UsageAccumulator } from "./usage-telemetry.js";
import { sniffUsageCost } from "./cost-sniffer.js";

/**
 * The in-shim OpenRouter cost proxy.
 *
 * Why it exists
 * -------------
 * OpenRouter returns the real, discount-inclusive charge for every call in the
 * response `usage.cost`. openclaw throws it away before anything downstream can
 * read it: its usage normalizer keeps only token counts, its OpenAI-compat
 * stream reports openclaw's own runId instead of OpenRouter's generation id, and
 * no plugin hook carries cost. So the shim cannot recover the real cost from
 * openclaw at all — the only place it survives is OpenRouter's raw HTTP
 * response.
 *
 * This proxy sits in front of OpenRouter: provisioning points
 * `models.providers.openrouter.baseUrl` at it (see render-workspace.ts), so
 * every model call openclaw makes flows through here on its way to
 * `openrouter.ai`. The proxy forwards the request and streams the response back
 * BYTE-FOR-BYTE UNCHANGED, while teeing a copy to a sniffer that reads
 * `usage.cost` off the trailing usage frame. The cost is handed to the
 * UsageAccumulator, which correlates it to the live turn by token counts (the
 * same per-call telemetry the knox-usage-telemetry plugin already feeds it).
 *
 * Safety posture
 * --------------
 *   - Loopback only. Bound to 127.0.0.1 — it carries the OpenRouter key and must
 *     never be reachable off-box. openclaw connects over loopback.
 *   - Transparent. It does not rewrite the request body (OpenRouter now returns
 *     cost unconditionally) so nothing about the call changes.
 *   - Fail-open on observation. Sniffing runs on a tee and is fully wrapped: a
 *     parse error, an oversize body, or an unexpected shape yields no cost and
 *     never touches the forwarded bytes. The worst case is a turn priced by the
 *     token estimate instead of the actual charge — exactly today's behavior.
 *   - Kill switch. OPENROUTER_COST_TRACKING=false (or a non-OpenRouter provider)
 *     skips the proxy entirely; provisioning then leaves openclaw pointed
 *     straight at OpenRouter.
 */

/** Hop-by-hop and connection-specific headers that must not be forwarded. */
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  // Force an identity response so the sniffer reads plaintext. openclaw handles
  // an uncompressed body fine; on loopback→OpenRouter the bandwidth is trivial.
  "accept-encoding",
]);

export interface CostProxyHandle {
  /** The loopback base URL to hand openclaw as the provider baseUrl. */
  readonly baseUrl: string;
  close(): Promise<void>;
}

/**
 * Whether the cost proxy should intercept this deployment: cost tracking on AND
 * the provider is OpenRouter (the only provider that returns a real cost). The
 * single source of truth shared by the boot path and provisioning, so
 * openclaw.json's baseUrl and the running proxy can never disagree.
 */
export function costTrackingEnabled(env: AgentEnv): boolean {
  return env.OPENROUTER_COST_TRACKING && env.LLM_PROVIDER.trim().toLowerCase() === "openrouter";
}

/** The loopback baseUrl openclaw's OpenRouter provider is pointed at. */
export function costProxyBaseUrl(env: AgentEnv): string {
  return `http://127.0.0.1:${env.OPENROUTER_COST_PROXY_PORT}/api/v1`;
}

/**
 * Resolve where the proxy forwards to. The real OpenRouter base, honoring an
 * operator LLM_BASE_URL override (some deployments pin a regional or gateway
 * OpenRouter host) and falling back to the public API.
 */
export function resolveUpstreamBase(env: AgentEnv): string {
  const raw = (env.OPENROUTER_UPSTREAM_URL || env.LLM_BASE_URL || "https://openrouter.ai/api/v1").trim();
  return raw.replace(/\/+$/, "");
}

/**
 * Map an incoming proxy path to the upstream path. openclaw appends the same
 * relative path it would append to the real base (e.g. `/chat/completions`),
 * and provisioning gives it a proxy baseUrl ending in `/api/v1`, so the
 * incoming path may arrive as `/api/v1/chat/completions` OR `/chat/completions`
 * depending on how openclaw composes it. Strip a leading `/api/v1` or `/v1`
 * either way, then append to the upstream base (which already carries its own
 * `/api/v1`). Idempotent and safe for both shapes.
 */
export function upstreamTarget(base: string, incomingPath: string): string {
  const suffix = incomingPath.replace(/^\/(?:api\/v1|v1)(?=\/|$)/, "");
  return base + (suffix.startsWith("/") ? suffix : `/${suffix}`);
}

/**
 * Start the cost proxy on a loopback port. Returns a handle carrying the
 * baseUrl provisioning should hand openclaw, or null when cost tracking is off
 * or the provider is not OpenRouter (nothing to intercept).
 */
export function startCostProxy(
  env: AgentEnv,
  usage: UsageAccumulator,
): Promise<CostProxyHandle | null> {
  if (!costTrackingEnabled(env)) {
    return Promise.resolve(null);
  }

  const upstreamBase = resolveUpstreamBase(env);
  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(upstreamBase);
  } catch {
    log.warn("cost proxy disabled: OPENROUTER_UPSTREAM_URL/LLM_BASE_URL is not a valid URL", {
      value: upstreamBase,
    });
    return Promise.resolve(null);
  }
  const forward = upstreamUrl.protocol === "http:" ? httpRequest : httpsRequest;

  const server = createServer((clientReq, clientRes) => {
    forwardRequest(clientReq, clientRes, env, usage, upstreamUrl, upstreamBase, forward);
  });
  // A slow or wedged model call must not be cut by the proxy — openclaw already
  // owns request timeouts. Disable the server's idle socket timeout.
  server.timeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  return new Promise((resolve) => {
    server.once("error", (err) => {
      // Never let a proxy bind failure take the vessel down: log and fall back
      // to direct OpenRouter (no cost capture) rather than crash the shim.
      log.error("cost proxy failed to start; continuing without cost capture", {
        err: String(err),
      });
      resolve(null);
    });
    server.listen(env.OPENROUTER_COST_PROXY_PORT, "127.0.0.1", () => {
      const baseUrl = `http://127.0.0.1:${env.OPENROUTER_COST_PROXY_PORT}/api/v1`;
      usage.enableCostCorrelation();
      log.info("cost proxy listening", {
        base_url: baseUrl,
        upstream: upstreamBase,
      });
      resolve({
        baseUrl,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

function forwardRequest(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  env: AgentEnv,
  usage: UsageAccumulator,
  upstreamUrl: URL,
  upstreamBase: string,
  forward: typeof httpRequest | typeof httpsRequest,
): void {
  const target = upstreamTarget(upstreamBase, clientReq.url ?? "/");
  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    clientRes.writeHead(502, { "content-type": "application/json" });
    clientRes.end(JSON.stringify({ error: { message: "cost proxy: bad upstream target" } }));
    return;
  }

  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(clientReq.headers)) {
    if (value === undefined) continue;
    if (STRIP_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  // Host must match the upstream for TLS SNI + OpenRouter routing.
  headers["host"] = targetUrl.host;

  const baseOptions = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
    method: clientReq.method,
    path: targetUrl.pathname + targetUrl.search,
    headers,
  };

  // Response side: relay status + headers verbatim (openclaw sees exactly what
  // OpenRouter sent, minus the content-encoding we suppressed), while teeing a
  // copy to the usage.cost sniffer. The forwarded copy governs backpressure; the
  // sniffer is an in-memory sink that never stalls the pipe, and any sniffer
  // fault is swallowed so it can never reach the forwarded stream.
  //
  // `sessionCacheKey` is the session openclaw stamped on THIS request
  // (`prompt_cache_key`); the captured cost is summed under it so the turn's
  // telemetry can claim the total. Null for non-chat requests (no cost to
  // attribute).
  const makeOnResponse =
    (sessionCacheKey: string | null) =>
    (upstreamRes: IncomingMessage): void => {
      clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      const sniffer = makeSniffer(upstreamRes.headers["content-type"], (sample) => {
        if (!sessionCacheKey) return;
        try {
          usage.recordCost(sessionCacheKey, sample);
          log.debug("cost proxy: captured cost", {
            session: sessionCacheKey,
            cost_usd: sample.costUsd,
            gen_id: sample.generationId ?? null,
          });
        } catch (err) {
          log.debug("cost proxy: recordCost threw (ignored)", { err: String(err) });
        }
      });
      upstreamRes.on("data", (chunk: Buffer) => {
        try {
          sniffer.write(chunk);
        } catch {
          /* sniffing must never affect forwarding */
        }
      });
      upstreamRes.on("end", () => {
        try {
          sniffer.end();
        } catch {
          /* ignore */
        }
      });
      upstreamRes.pipe(clientRes);
    };

  const wire = (req: ClientRequest): void => {
    req.on("error", (err) => {
      log.warn("cost proxy: upstream request error", { err: String(err) });
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "content-type": "application/json" });
        clientRes.end(
          JSON.stringify({ error: { message: `cost proxy upstream error: ${String(err)}` } }),
        );
      } else {
        clientRes.end();
      }
    });
    // If openclaw hangs up, tear down the upstream call too.
    clientRes.on("close", () => {
      if (!req.destroyed) req.destroy();
    });
  };

  // Only a chat-completions POST carries a body worth rewriting. Everything else
  // (model-catalog GETs, generation lookups, …) streams straight through.
  const contentType = typeof headers["content-type"] === "string" ? headers["content-type"] : "";
  const isChatPost =
    (clientReq.method ?? "").toUpperCase() === "POST" &&
    contentType.toLowerCase().includes("application/json") &&
    targetUrl.pathname.endsWith("/chat/completions");

  if (!isChatPost) {
    const upstreamReq = forward(baseOptions, makeOnResponse(null));
    wire(upstreamReq);
    clientReq.on("aborted", () => {
      if (!upstreamReq.destroyed) upstreamReq.destroy();
    });
    clientReq.pipe(upstreamReq);
    return;
  }

  // Chat POST: buffer the body to (1) read `prompt_cache_key` — the session id
  // that ties every one of this turn's calls together, so the proxy can sum their
  // costs and the turn's telemetry can claim the total — and (2) inject
  // `usage: { include: true }` so OpenRouter returns the per-request cost at all
  // (openclaw doesn't ask, and OpenRouter emits it only when asked). If the body
  // isn't parseable JSON it forwards UNCHANGED with no session key, and if it
  // exceeds the cap (never for a real chat request) it streams through unchanged —
  // a request must never break for the sake of cost capture.
  const chunks: Buffer[] = [];
  let size = 0;
  let streaming = false;
  let aborted = false;
  let upstreamReq: ClientRequest | null = null;

  clientReq.on("aborted", () => {
    aborted = true;
    if (upstreamReq && !upstreamReq.destroyed) upstreamReq.destroy();
  });

  clientReq.on("data", (chunk: Buffer) => {
    if (streaming) return;
    chunks.push(chunk);
    size += chunk.length;
    if (size > MAX_INJECT_BODY_BYTES) {
      // Over the cap: forward the original body (unchanged content-length),
      // without cost capture — buffered chunks first, then the streamed remainder.
      streaming = true;
      upstreamReq = forward(baseOptions, makeOnResponse(null));
      wire(upstreamReq);
      for (const c of chunks) upstreamReq.write(c);
      chunks.length = 0;
      clientReq.pipe(upstreamReq);
    }
  });

  clientReq.on("end", () => {
    if (streaming || aborted) return;
    const raw = Buffer.concat(chunks);
    const { body, sessionCacheKey, requestKeys } = prepareChatBody(raw);
    headers["content-length"] = String(body.length);
    log.debug("cost proxy: forwarding chat request", {
      has_session_key: Boolean(sessionCacheKey),
      injected: body !== raw,
      request_keys: requestKeys,
    });
    upstreamReq = forward(baseOptions, makeOnResponse(sessionCacheKey));
    wire(upstreamReq);
    upstreamReq.end(body);
  });
}

/** Bodies up to this size get parsed + rewritten to add usage accounting; larger
 *  ones stream through unchanged. A real chat request is a few MB at most. */
const MAX_INJECT_BODY_BYTES = 8_000_000;

/**
 * Prepare an OpenRouter chat-completions request body: pull out
 * `prompt_cache_key` (the session id that ties a turn's calls together, so their
 * costs can be summed and attributed) and add `usage: { include: true }` (so the
 * response carries the per-request cost at all). The injection merges into any
 * existing `usage` object and leaves every other field untouched.
 *
 * On a body that is not a JSON object — or that fails to re-serialize — returns
 * the ORIGINAL bytes and a null session key, so the request forwards unchanged
 * and simply isn't costed. A request must never break for the sake of cost.
 */
export function prepareChatBody(raw: Buffer): {
  body: Buffer;
  sessionCacheKey: string | null;
  /** Top-level request field NAMES (never values/content) — diagnostic only, to
   *  discover which field, if any, carries a per-request session identifier. */
  requestKeys: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return { body: raw, sessionCacheKey: null, requestKeys: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { body: raw, sessionCacheKey: null, requestKeys: [] };
  }
  const obj = parsed as Record<string, unknown>;
  const requestKeys = Object.keys(obj);
  // openclaw's session id is usually `prompt_cache_key`; `user` is the common
  // OpenAI-style fallback some setups use instead.
  const sessionCacheKey =
    (typeof obj.prompt_cache_key === "string" && obj.prompt_cache_key
      ? obj.prompt_cache_key
      : typeof obj.user === "string" && obj.user
        ? obj.user
        : null);
  const existing =
    obj.usage && typeof obj.usage === "object" && !Array.isArray(obj.usage)
      ? (obj.usage as Record<string, unknown>)
      : {};
  obj.usage = { ...existing, include: true };
  try {
    return { body: Buffer.from(JSON.stringify(obj), "utf8"), sessionCacheKey, requestKeys };
  } catch {
    return { body: raw, sessionCacheKey, requestKeys };
  }
}

/**
 * A tiny stream-shaped adapter around the pure sniffUsageCost parser. Returns an
 * object with `write`/`end`; it feeds bytes to the parser and calls `onCost`
 * once, on end, if a usable cost was found. Deliberately NOT a real
 * stream.Writable — it must never exert backpressure on the tee.
 */
function makeSniffer(
  contentType: string | undefined,
  onCost: (sample: import("./usage-telemetry.js").CostSample) => void,
): Pick<Writable, "write" | "end"> {
  const parser = sniffUsageCost(contentType);
  return {
    write(chunk: Buffer): boolean {
      try {
        parser.push(chunk);
      } catch {
        /* fail-open */
      }
      return true;
    },
    end(): Writable {
      try {
        const sample = parser.finish();
        if (sample) onCost(sample);
        // One-shot diagnosis of "does OpenRouter return cost inline?" — logs the
        // usage frame's field NAMES (never values or content) whenever a usage
        // frame was seen but did not yield a cost. Debug-level, so it's off in
        // normal operation.
        const d = parser.diagnostics();
        if (d.sawUsage && !sample) {
          log.debug("cost proxy: usage frame had no usable cost", {
            had_cost: d.hadCost,
            usage_keys: d.keys,
          });
        }
      } catch {
        /* fail-open */
      }
      // The tee never reads this return; satisfy the type only.
      return undefined as unknown as Writable;
    },
  } as Pick<Writable, "write" | "end">;
}
