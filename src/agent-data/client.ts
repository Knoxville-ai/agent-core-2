import { log } from "../log.js";
import type { AgentEnv } from "../env.js";

/**
 * Client for the console's agent data API (POST ${PLATFORM_AGENT_DATA_URL}).
 *
 * The console exposes everything this container needs from the platform
 * database and Storage (its conversations and messages, tool-call ledger,
 * memories, live-turn broadcasts and its own `orgs/<org>/agents/<uid>/` files)
 * as named operations, authenticated with this agent's own PLATFORM_API_TOKEN
 * and scoped on the server to this agent's org and uid. Downloads come back as
 * short-lived signed URLs.
 *
 * Which path a container uses is decided once at boot by
 * {@link resolveDataAccess}:
 *   - "scoped": the console set PLATFORM_AGENT_DATA_URL, the agent has its
 *     PLATFORM_API_TOKEN, and the API answered `hello`. Every data path goes
 *     through this client and the database key is unused (and dropped from the
 *     environment the gateway and its tools inherit).
 *   - "service-key": the console does not offer the API yet (or it did not
 *     answer and the container still has SUPABASE_SERVICE_ROLE_KEY). The data
 *     paths use the key directly, as before.
 */

export class AgentDataCallError extends Error {
  constructor(
    readonly op: string,
    readonly status: number,
    message: string,
  ) {
    super(`agent data ${op} (${status}): ${message}`);
    this.name = "AgentDataCallError";
  }
}

export interface AgentDataClientOptions {
  url: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class AgentDataClient {
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AgentDataClientOptions) {
    this.url = opts.url;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Run one operation. Throws AgentDataCallError on a refused or failed call. */
  async call<T = Record<string, unknown>>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ ...args, op }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AgentDataCallError(op, 0, String(err));
    }
    const body = (await res.json().catch(() => null)) as
      | { ok?: unknown; result?: unknown; error?: unknown }
      | null;
    if (!res.ok || body?.ok !== true) {
      const message = typeof body?.error === "string" ? body.error : res.statusText || "failed";
      throw new AgentDataCallError(op, res.status, message);
    }
    return (body.result ?? {}) as T;
  }

  /** GET a signed download URL the API handed out. Null when the object is gone. */
  async fetchSigned(url: string, timeoutMs = 60_000): Promise<Response | null> {
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new Error(`signed download ${res.status}`);
    return res;
  }

  /** Sign + fetch an agent-relative file as text; null when it doesn't exist. */
  async downloadText(op: "storage.sign" | "storage.shared.sign", args: Record<string, unknown>): Promise<string | null> {
    const { url } = await this.call<{ url: string | null }>(op, args);
    if (!url) return null;
    const res = await this.fetchSigned(url);
    return res ? await res.text() : null;
  }
}

/** True once boot has settled on the agent data API for this container. */
export function usesScopedData(env: Pick<AgentEnv, "PLATFORM_AGENT_DATA_URL" | "PLATFORM_API_TOKEN">): boolean {
  return Boolean(env.PLATFORM_AGENT_DATA_URL && env.PLATFORM_API_TOKEN);
}

const clients = new Map<string, AgentDataClient>();

/** The process-wide client, or null when this container uses the database key. */
export function agentDataClientFromEnv(
  env: Pick<AgentEnv, "PLATFORM_AGENT_DATA_URL" | "PLATFORM_API_TOKEN">,
): AgentDataClient | null {
  if (!usesScopedData(env)) return null;
  const url = env.PLATFORM_AGENT_DATA_URL!;
  const token = env.PLATFORM_API_TOKEN!;
  const key = `${url}\u0000${token}`;
  let client = clients.get(key);
  if (!client) {
    client = new AgentDataClient({ url, token });
    clients.set(key, client);
  }
  return client;
}

/** Platform-wide credentials a scoped container never needs. */
export const PLATFORM_WIDE_ENV_VARS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "AGENT_SUPABASE_SECRET_KEY",
  "GOOGLE_CSE_API_KEY",
  "GOOGLE_CSE_ID",
] as const;

export type DataAccessMode = "scoped" | "service-key";

/** `hello`, retried briefly while the console is unreachable or erroring. */
async function helloWithRetry(
  client: AgentDataClient,
  attempts = 3,
  delayMs = 2_000,
): Promise<{ org_id?: unknown; agent_uid?: unknown }> {
  for (let i = 1; ; i++) {
    try {
      return await client.call<{ org_id?: unknown; agent_uid?: unknown }>("hello");
    } catch (err) {
      const transient = err instanceof AgentDataCallError && (err.status === 0 || err.status >= 500);
      if (!transient || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
}

/**
 * Decide, once at boot, how this container reaches platform data (see the
 * module comment), and settle `env` accordingly:
 *   - scoped: drop the platform-wide credentials from `env` and from
 *     `processEnv`, so neither this process's code nor anything it spawns (the
 *     gateway and the tools it runs) inherits them;
 *   - service-key: clear PLATFORM_AGENT_DATA_URL from `env` so every data path
 *     agrees.
 * Throws when neither path is available: the container can't run.
 */
export async function resolveDataAccess(
  env: AgentEnv,
  processEnv: NodeJS.ProcessEnv = process.env,
  makeClient: (env: AgentEnv) => AgentDataClient | null = agentDataClientFromEnv,
): Promise<DataAccessMode> {
  const hasKey = Boolean(env.SUPABASE_SERVICE_ROLE_KEY);
  const client = makeClient(env);
  if (client) {
    try {
      const hello = await helloWithRetry(client);
      if (hello.org_id !== env.AGENT_ORG || hello.agent_uid !== env.AGENT_UID) {
        throw new Error("the platform token belongs to a different agent");
      }
      env.SUPABASE_SERVICE_ROLE_KEY = "";
      for (const name of PLATFORM_WIDE_ENV_VARS) delete processEnv[name];
      log.info("platform data: scoped agent data API");
      return "scoped";
    } catch (err) {
      if (!hasKey) {
        throw new Error(`agent data API unavailable and no database key is set: ${String(err)}`);
      }
      log.warn("agent data API unavailable; using the database key", { err: String(err) });
    }
  }
  if (!hasKey) {
    throw new Error("no platform data access: set PLATFORM_AGENT_DATA_URL + PLATFORM_API_TOKEN");
  }
  env.PLATFORM_AGENT_DATA_URL = undefined;
  return "service-key";
}
