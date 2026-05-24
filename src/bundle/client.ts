import { log } from "../log.js";
import type { AgentBundle } from "./types.js";

/**
 * Minimal MCP JSON-RPC client against the platform's Streamable HTTP
 * server. We don't open the SSE channel — bundle fetch is a single POST
 * + response. Only the methods we need (`tools/call get_my_bundle`) are
 * implemented.
 */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export interface BundleClientOptions {
  /** Base MCP URL (e.g. https://knoxville.ai/api/mcp). */
  url: string;
  /** Agent's knox_agent_* bearer token. */
  token: string;
  /** Timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
}

export class BundleClient {
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(opts: BundleClientOptions) {
    this.url = opts.url;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** Fetch the agent's bundle. Returns `null` if the server reports no
   *  capabilities; throws on transport, auth, or protocol failure. */
  async fetchBundle(): Promise<AgentBundle> {
    const result = await this.call<ToolCallResult>("tools/call", {
      name: "get_my_bundle",
      arguments: {},
    });
    if (result.isError) {
      const msg = result.content?.find((c) => c.type === "text")?.text ?? "tool reported error";
      throw new Error(`get_my_bundle failed: ${msg}`);
    }
    const bundle = result.structuredContent as AgentBundle | undefined;
    if (!bundle || !Array.isArray(bundle.assignments)) {
      throw new Error("get_my_bundle returned no structured content");
    }
    return bundle;
  }

  private async call<T>(method: string, params: unknown): Promise<T> {
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) {
      throw new Error(
        `platform MCP rejected agent token (401). Check PLATFORM_API_TOKEN.`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`platform MCP ${res.status}: ${text || res.statusText}`);
    }
    const body = (await res.json()) as JsonRpcResponse<T>;
    if (body.error) {
      throw new Error(
        `platform MCP error ${body.error.code}: ${body.error.message}`,
      );
    }
    if (body.result === undefined) {
      throw new Error(`platform MCP returned no result for ${method}`);
    }
    return body.result;
  }
}

/** Convenience: build a client from env or return null if MCP isn't wired. */
export function bundleClientFromEnv(env: {
  PLATFORM_MCP_URL?: string;
  PLATFORM_API_TOKEN?: string;
}): BundleClient | null {
  if (!env.PLATFORM_MCP_URL) {
    log.info("bundle: PLATFORM_MCP_URL not set — skipping bundle fetch");
    return null;
  }
  if (!env.PLATFORM_API_TOKEN) {
    throw new Error(
      "PLATFORM_MCP_URL is set but PLATFORM_API_TOKEN is missing — refusing to fetch bundle without auth",
    );
  }
  return new BundleClient({
    url: env.PLATFORM_MCP_URL,
    token: env.PLATFORM_API_TOKEN,
  });
}
