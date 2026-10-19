import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { BundleClient, type ToolCallResult } from "../bundle/client.js";
import type { AgentEnv } from "../env.js";
import { log } from "../log.js";

/**
 * Process events: the vessel's half of the console's agent event hook (console
 * phase 5, spec DECISIONS 64).
 *
 * The console declares, per MCP surface, which write tools change business
 * records and how (spec/registry/tool-actions/). This reporter asks it which
 * tools those are, asks it before a declared write runs whether the call may
 * (guard_tool_call), and tells it when one returned (record_tool_call), which
 * turns the call into kernel events with this agent as actor. All three are
 * runtime-broker tools on the platform MCP, called with the agent's own token.
 *
 * Two observers feed it: the knox-process-events openclaw plugin (MCP servers
 * openclaw calls, through the /internal/process-events/* loopback routes) and
 * the MCP relay (MCP URLs skills call from scripts; see mcp-relay.ts).
 *
 * Posture:
 *   - Fail open. A guard that can't reach the console allows the call; only an
 *     answer that says "refused" blocks, and the console says that only while it
 *     enforces. A report that can't be delivered is retried, then dropped with a
 *     warning: the call itself already happened and is never affected.
 *   - Cheap for everything else. Undeclared tools are answered from a cached
 *     declaration list without a network call.
 */

const DECLARATIONS_TTL_MS = 10 * 60_000;
const DECLARATIONS_RETRY_MS = 60_000;
const GUARD_TIMEOUT_MS = 3_000;
const RECORD_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [2_000, 10_000, 60_000];
const MAX_PENDING = 500;

/** What the console declares: each surface's write tools, and the surface of each of the agent's MCP servers. */
export interface Declarations {
  surfaces: Record<string, { tools: string[] }>;
  servers: Record<string, string>;
}

/** Where a call went: a surface named directly (the relay), or an MCP server by its mcp.servers name (the plugin). */
export interface CallTarget {
  surface?: string;
  server?: string;
  tool: string;
}

export interface GuardVerdict {
  allowed: boolean;
  reason: string | null;
}

export interface ToolCallReport extends CallTarget {
  args: Record<string, unknown>;
  result?: unknown;
  isError: boolean;
  /** Unique per call: the console derives event IDs from it, so a retry emits nothing new. */
  callId: string;
  finishedAt: string;
}

/** The part of BundleClient the reporter uses (tests pass a fake). */
export interface BrokerClient {
  callTool(name: string, args: unknown): Promise<ToolCallResult>;
}

/**
 * `<server>__<tool>` (openclaw's MCP namespacing) as its parts, or null for a
 * built-in tool. The platform's own server is never reported: its write tools
 * emit their events themselves.
 */
export function splitToolName(name: string): { server: string; tool: string } | null {
  const m = /^([a-zA-Z0-9_-]+?)__(.+)$/.exec(name);
  const [, server, tool] = m ?? [];
  if (!server || !tool || server === "knoxville_platform") return null;
  return { server, tool };
}

/** PROCESS_EVENTS_RELAY ("VAR=surface,VAR2=surface2") as [var, surface] pairs. */
export function parseRelayMap(raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const part of raw.split(",")) {
    const [name, surface] = part.split("=").map((s) => s.trim());
    if (name && surface && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && /^[a-z][a-z0-9-]*$/.test(surface)) out.push([name, surface]);
  }
  return out;
}

const structured = (r: ToolCallResult): Record<string, unknown> | null =>
  r.structuredContent && typeof r.structuredContent === "object" ? (r.structuredContent as Record<string, unknown>) : null;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class ProcessEvents {
  private declarations: Declarations | null = null;
  private fetchedAt = 0;
  private retryAt = 0;
  private inflight: Promise<Declarations | null> | null = null;
  private pending = 0;

  constructor(
    private readonly client: BrokerClient,
    private readonly runtimeVersion: string,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** The console's declarations, cached; null until the console has answered once. */
  async load(): Promise<Declarations | null> {
    const t = this.now();
    if (this.declarations && t - this.fetchedAt < DECLARATIONS_TTL_MS) return this.declarations;
    if (t < this.retryAt) return this.declarations;
    this.inflight ??= (async () => {
      try {
        const r = await withTimeout(this.client.callTool("get_tool_actions", {}), GUARD_TIMEOUT_MS);
        const body = structured(r);
        if (r.isError || !body) throw new Error(r.content?.[0]?.text ?? "no declarations");
        this.declarations = {
          surfaces: (body.surfaces as Declarations["surfaces"]) ?? {},
          servers: (body.servers as Declarations["servers"]) ?? {},
        };
        this.fetchedAt = this.now();
      } catch (err) {
        this.retryAt = this.now() + DECLARATIONS_RETRY_MS;
        log.warn("process events: no tool declarations from the console", { err: String(err) });
      } finally {
        this.inflight = null;
      }
      return this.declarations;
    })();
    return await this.inflight;
  }

  /** The surface a call went to, when the console declares the tool there. */
  async declaredSurface(target: CallTarget): Promise<string | null> {
    const d = await this.load();
    if (!d) return null;
    const surface = target.surface ?? (target.server ? d.servers[target.server] : undefined);
    if (!surface) return null;
    return d.surfaces[surface]?.tools.includes(target.tool) ? surface : null;
  }

  /** May this call run? Undeclared tools always may; a declared write asks the console, and errors allow. */
  async guard(target: CallTarget, args: Record<string, unknown>): Promise<GuardVerdict> {
    const surface = await this.declaredSurface(target);
    if (!surface) return { allowed: true, reason: null };
    try {
      const r = await withTimeout(this.client.callTool("guard_tool_call", { surface, tool: target.tool, args }), GUARD_TIMEOUT_MS);
      const body = structured(r);
      if (r.isError || !body) throw new Error(r.content?.[0]?.text ?? "no verdict");
      if (body.would_allow === false) {
        log.warn("process events: the kernel would refuse this write", {
          surface, tool: target.tool, enforced: body.enforced === true, reason: body.reason ?? null,
        });
      }
      return { allowed: body.allowed !== false, reason: typeof body.reason === "string" ? body.reason : null };
    } catch (err) {
      log.warn("process events: guard unavailable; allowing", { surface, tool: target.tool, err: String(err) });
      return { allowed: true, reason: null };
    }
  }

  /**
   * Report a returned call, in the background: undeclared calls are dropped
   * here, declared ones are sent with retries. Never throws. Resolves when the
   * report is delivered or given up (tests await it; callers needn't).
   */
  async record(report: ToolCallReport): Promise<void> {
    const surface = await this.declaredSurface(report);
    if (!surface) return;
    if (this.pending >= MAX_PENDING) {
      log.warn("process events: report queue full; dropping", { surface, tool: report.tool });
      return;
    }
    this.pending++;
    try {
      const body = {
        surface,
        tool: report.tool,
        args: report.args,
        result: report.result,
        is_error: report.isError,
        call_id: report.callId,
        finished_at: report.finishedAt,
        runtime_version: this.runtimeVersion,
      };
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await withTimeout(this.client.callTool("record_tool_call", body), RECORD_TIMEOUT_MS);
          if (r.isError) throw new Error(r.content?.[0]?.text ?? "refused");
          const out = structured(r);
          const skipped = Array.isArray(out?.skipped) ? out.skipped : [];
          if (skipped.length) log.warn("process events: some planned events were not emitted", { surface, tool: report.tool, skipped });
          return;
        } catch (err) {
          if (attempt >= RETRY_DELAYS_MS.length) {
            log.warn("process events: report not delivered; dropping", { surface, tool: report.tool, err: String(err) });
            return;
          }
          await this.sleep(RETRY_DELAYS_MS[attempt] ?? 60_000);
        }
      }
    } finally {
      this.pending--;
    }
  }
}

/** The vessel's reporter, or null when process events are off or the platform MCP isn't configured. */
export function processEventsFromEnv(env: AgentEnv, runtimeVersion: string): ProcessEvents | null {
  if (!env.PROCESS_EVENTS || !env.PLATFORM_MCP_URL || !env.PLATFORM_API_TOKEN) return null;
  return new ProcessEvents(new BundleClient({ url: env.PLATFORM_MCP_URL, token: env.PLATFORM_API_TOKEN }), runtimeVersion);
}

/** A call ID for a call its observer can't name uniquely. */
export const newCallId = () => `vessel:${randomUUID()}`;

/** This runtime's version (package.json), the events' source.version. */
export function runtimeVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}
