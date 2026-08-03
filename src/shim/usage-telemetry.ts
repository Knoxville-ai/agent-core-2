import { log } from "../log.js";

/**
 * One model call's token usage, as reported by the openclaw `llm_output` hook
 * via the `knox-usage-telemetry` plugin.
 *
 * `input` here is the UNCACHED input only — openclaw normalizes the provider's
 * numbers into `{input, output, cacheRead, cacheWrite}` before the hook fires.
 * That is the distinction the OpenAI-compat `/v1/chat/completions` endpoint
 * destroys downstream (it emits `prompt_tokens = input + cacheRead`), and the
 * whole reason this side channel exists.
 */
export interface UsageSample {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total?: number;
  provider?: string;
  model?: string;
  resolved_ref?: string;
}

/** Per-turn rollup of every model call openclaw made inside one agentic run. */
export interface CacheUsageTotals {
  /** Number of model calls in the turn — i.e. agentic loop iterations. */
  modelCalls: number;
  /** Input tokens billed at the full (uncached) rate. */
  uncachedInput: number;
  /** Input tokens served from the prompt cache (priced at cached_input rate). */
  cacheRead: number;
  /** Input tokens written into the prompt cache (priced at cache-write rate). */
  cacheWrite: number;
  /** Resolved provider/model ref of the last call, when reported. */
  resolvedRef?: string;
}

/** Coerce to a finite non-negative integer. Defensive: this data crosses HTTP. */
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/** Parse an untrusted `/internal/llm-usage` body into a sample, or null. */
export function parseUsageSample(body: unknown): UsageSample | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as Record<string, unknown>).sample;
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const sample: UsageSample = {
    input: count(s.input),
    output: count(s.output),
    cache_read: count(s.cache_read),
    cache_write: count(s.cache_write),
  };
  if (
    sample.input === 0 &&
    sample.output === 0 &&
    sample.cache_read === 0 &&
    sample.cache_write === 0
  ) {
    return null;
  }
  const total = count(s.total);
  if (total > 0) sample.total = total;
  if (typeof s.provider === "string" && s.provider) sample.provider = s.provider;
  if (typeof s.model === "string" && s.model) sample.model = s.model;
  if (typeof s.resolved_ref === "string" && s.resolved_ref) {
    sample.resolved_ref = s.resolved_ref;
  }
  return sample;
}

/**
 * Accumulates per-model-call usage samples, keyed by openclaw session key, for
 * the lifetime of one turn.
 *
 * The shim opens ONE upstream request per turn and openclaw loops internally, so
 * a turn's samples all arrive between `begin()` and `drain()` under the same
 * session key. `begin()` resets rather than merges, so a retried turn does not
 * inherit the previous attempt's totals.
 *
 * Concurrency caveat: `webchat:<convId>` session keys are NOT unique across
 * simultaneous turns (a caller that re-sends after its MCP client times out is
 * the common way to get two live turns on one conversation — see the note in
 * `task-runner.ts`). When that happens the two turns' samples merge into
 * whichever drains first. `task:<taskId>` keys are unique, so the long-running
 * task path — which is where the token volume actually is — is exact. Telemetry
 * only; it never affects a turn's behavior.
 */
export class UsageAccumulator {
  #bySession = new Map<string, CacheUsageTotals>();

  /** Start (or restart) accumulation for a turn. */
  begin(sessionKey: string): void {
    this.#bySession.set(sessionKey, {
      modelCalls: 0,
      uncachedInput: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  }

  /** Fold one model call's usage into the live turn. No-op if none is open. */
  add(sessionKey: string, sample: UsageSample): void {
    const totals = this.#bySession.get(sessionKey);
    // No open turn: the sample belongs to something the shim did not start
    // (a heartbeat, a subagent, a cron wake). Drop it rather than inventing a
    // bucket that nothing will ever drain.
    if (!totals) return;
    totals.modelCalls += 1;
    totals.uncachedInput += sample.input;
    totals.cacheRead += sample.cache_read;
    totals.cacheWrite += sample.cache_write;
    if (sample.resolved_ref) totals.resolvedRef = sample.resolved_ref;
  }

  /** Take and clear the turn's totals. Returns null when nothing accumulated. */
  drain(sessionKey: string): CacheUsageTotals | null {
    const totals = this.#bySession.get(sessionKey) ?? null;
    this.#bySession.delete(sessionKey);
    if (!totals || totals.modelCalls === 0) return null;
    return totals;
  }

  /** Drop a turn's bucket without reading it (abort/error paths). */
  clear(sessionKey: string): void {
    this.#bySession.delete(sessionKey);
  }

  /** Live bucket count — for the health route and leak diagnosis. */
  size(): number {
    return this.#bySession.size;
  }
}

/**
 * Log a one-line cache summary per turn. This is the number the platform has
 * never been able to see: with no cache in play `hit_pct` is 0 and every input
 * token is billed at the full rate.
 */
export function logUsageTotals(sessionKey: string, totals: CacheUsageTotals): void {
  const billedInput = totals.uncachedInput + totals.cacheRead;
  const hitPct =
    billedInput > 0 ? Math.round((totals.cacheRead / billedInput) * 1000) / 10 : 0;
  log.info("turn usage", {
    session_key: sessionKey,
    model_calls: totals.modelCalls,
    uncached_input: totals.uncachedInput,
    cache_read: totals.cacheRead,
    cache_write: totals.cacheWrite,
    cache_hit_pct: hitPct,
    resolved_ref: totals.resolvedRef ?? null,
  });
}
