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

/**
 * A map of `ENV_KEY -> secret value` a delegating (calling) agent shared with
 * this agent for the current agent-to-agent turn. The values are secrets: never
 * log them, and never put them in the model prompt or the conversation
 * transcript — they belong only in the skill/tool execution environment.
 */
export type DelegatedCredentials = Record<string, string>;

/** Env var names we're willing to inject. Anything else is dropped — a junk key
 *  could break a subprocess spawn, and the platform only ever shares real
 *  env-var-shaped keys. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Pull the `{ credentials: { KEY: value } }` map out of the
 * `get_delegated_credentials` tool's structuredContent. Keeps only string
 * values under valid env-var-name keys; returns `{}` for any other shape. Never
 * throws. Exported for unit tests.
 */
export function extractDelegatedCredentials(
  structuredContent: unknown,
): DelegatedCredentials {
  const container = structuredContent as { credentials?: unknown } | null | undefined;
  const raw = container?.credentials;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: DelegatedCredentials = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && ENV_KEY_RE.test(key)) {
      out[key] = value;
    }
  }
  return out;
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
    // `connections` is newer than `assignments` on the wire — tolerate a
    // console that predates it by defaulting to an empty list.
    if (!Array.isArray(bundle.connections)) {
      bundle.connections = [];
    }
    return bundle;
  }

  /**
   * Fetch the credentials a delegating (calling) agent shared with us for the
   * agent-to-agent turn on `conversationId`. Reuses the SAME MCP endpoint +
   * agent token as `get_my_bundle`; the platform authorizes the call (verifies
   * we are the target of that delegated conversation and that the connection
   * shares the creds) and audits each access, so no extra checks are needed
   * here.
   *
   * Returns an empty map when nothing is shared OR on any tool/transport error:
   * a delegated turn must never crash because the broker hiccuped — the skill
   * surfaces its own auth error instead. NEVER logs the secret values (only the
   * key names + count, which are not secret and are useful for audit).
   */
  async fetchDelegatedCredentials(
    conversationId: string,
  ): Promise<DelegatedCredentials> {
    let result: ToolCallResult;
    try {
      result = await this.call<ToolCallResult>("tools/call", {
        name: "get_delegated_credentials",
        arguments: { conversation_id: conversationId },
      });
    } catch (err) {
      log.warn("delegated credentials fetch failed; proceeding without", {
        err: String(err),
      });
      return {};
    }
    if (result.isError) {
      const msg =
        result.content?.find((c) => c.type === "text")?.text ??
        "tool reported error";
      log.warn("delegated credentials tool reported error; proceeding without", {
        msg,
      });
      return {};
    }
    const creds = extractDelegatedCredentials(result.structuredContent);
    const keys = Object.keys(creds);
    if (keys.length > 0) {
      // Key NAMES + count only — never the values.
      log.info("delegated credentials received", { count: keys.length, keys: keys.sort() });
    }
    return creds;
  }

  /**
   * Fetch a boot-time digest of this agent's durable memories via the platform
   * `recall` tool (no query → pinned + top-salience rows). Returns the tool's
   * text digest, or null when there is nothing to show OR on any error — the
   * `# MEMORY` SOUL section is simply omitted. Never throws.
   */
  async fetchMemoryDigest(): Promise<string | null> {
    let result: ToolCallResult;
    try {
      result = await this.call<ToolCallResult>("tools/call", {
        name: "recall",
        arguments: { limit: 15 },
      });
    } catch (err) {
      log.warn("recall (boot digest) failed; proceeding without", {
        err: String(err),
      });
      return null;
    }
    if (result.isError) return null;
    const text = result.content?.find((c) => c.type === "text")?.text?.trim();
    return text && text.length > 0 ? text : null;
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
