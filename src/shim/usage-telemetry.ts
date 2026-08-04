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

/**
 * One model call's ACTUAL cost, as read straight off OpenRouter's response by
 * the in-shim cost proxy (see cost-proxy.ts).
 *
 * openclaw discards OpenRouter's `usage.cost` before any plugin or its
 * OpenAI-compat endpoint can see it (its usage normalizer keeps only token
 * counts, and the compat stream reports openclaw's own runId, not the
 * OpenRouter generation id). So the only place the real, discount-inclusive
 * charge survives is OpenRouter's raw HTTP response — which the cost proxy
 * observes as it forwards each call. This sample carries that charge plus the
 * token counts we correlate it back to a session by.
 */
export interface CostSample {
  /** Total USD charged to the OpenRouter account for this call (`usage.cost`). */
  costUsd: number;
  /** Upstream provider's own charge (`usage.cost_details.upstream_inference_cost`). */
  upstreamCostUsd?: number;
  /** OpenRouter `usage.prompt_tokens` — kept for logging/diagnostics only. */
  promptTokens: number;
  /** OpenRouter `usage.completion_tokens` — kept for logging/diagnostics only. */
  completionTokens: number;
  /** Response model id, for logging. */
  model?: string;
  /** OpenRouter generation id (`gen-…`), kept for audit/debug only. */
  generationId?: string;
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
  /**
   * Sum of ACTUAL OpenRouter charges (USD) for the calls in this turn the cost
   * proxy managed to correlate. `undefined` when nothing was costed (proxy off,
   * a non-OpenRouter provider, or the correlation missed) — the console then
   * falls back to its token×rate estimate for the turn, exactly as before.
   */
  costUsd?: number;
  /** Sum of upstream provider charges (USD), when reported. */
  upstreamCostUsd?: number;
  /** How many of this turn's model calls had an actual cost attached — the
   *  honest coverage denominator for a partially-correlated turn. */
  costedCalls?: number;
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
/**
 * Cap on the per-session cost map. It holds one entry per session with unclaimed
 * cost — normally the milliseconds between the proxy recording a call's cost and
 * the turn's telemetry claiming it. The cap is a leak backstop for sessions whose
 * telemetry never arrives (a heartbeat/subagent the shim never bracketed): over
 * the cap we evict the oldest, losing at most one session's cost, never unbounded
 * memory.
 */
const MAX_COST_SESSIONS = 1024;

/** Actual cost accumulated for one openclaw session's in-flight turn. */
interface SessionCost {
  costUsd: number;
  upstreamCostUsd: number;
  hasUpstream: boolean;
  /** OpenRouter calls costed this turn — the REAL per-turn call count, which the
   *  plugin's per-turn `llm_output` event cannot see (it reports model_calls=1). */
  calls: number;
}

/** Fold a session's accumulated cost into a turn's running totals. */
function foldSessionCost(totals: CacheUsageTotals, cost: SessionCost): void {
  totals.costUsd = (totals.costUsd ?? 0) + cost.costUsd;
  if (cost.hasUpstream) {
    totals.upstreamCostUsd = (totals.upstreamCostUsd ?? 0) + cost.upstreamCostUsd;
  }
  totals.costedCalls = (totals.costedCalls ?? 0) + cost.calls;
}

export class UsageAccumulator {
  #bySession = new Map<string, CacheUsageTotals>();
  /**
   * Actual cost accumulated per openclaw SESSION, keyed by the id openclaw
   * stamps on the request (`prompt_cache_key`). openclaw's `llm_output` hook
   * fires ONCE per turn with usage summed across the turn's many model calls, so
   * per-call token-tuple matching cannot work — the plugin's single aggregate
   * never equals any one call's counts. Instead the proxy sums a session's
   * per-call costs here as the calls complete, and the turn's telemetry claims
   * the running total when it lands (all the turn's calls are done by then).
   */
  #costBySession = new Map<string, SessionCost>();
  /** Off until the cost proxy starts. While off, `add`/`recordCost` do no
   *  correlation work, so a deployment with no proxy (or a non-OpenRouter
   *  provider) never accumulates anything here. */
  #costCorrelation = false;

  /** Turn on cost correlation. Called once, when the cost proxy binds. */
  enableCostCorrelation(): void {
    this.#costCorrelation = true;
  }

  /** Start (or restart) accumulation for a turn. */
  begin(sessionKey: string): void {
    this.#bySession.set(sessionKey, {
      modelCalls: 0,
      uncachedInput: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  }

  /**
   * Fold a turn's usage into the live bucket. No-op if none is open.
   *
   * openclaw's `llm_output` fires ONCE per turn with usage summed across the
   * turn's model calls, so this runs once per turn (which is why `modelCalls`
   * counts telemetry events, not calls). `sessionId` is openclaw's session id
   * off that event — the key the proxy summed this turn's actual cost under.
   */
  add(sessionKey: string, sample: UsageSample, sessionId?: string): void {
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

    // Claim the actual cost the proxy summed for this session's turn. openclaw
    // stamps the same session id on the request (which the proxy keyed by) and
    // on this llm_output event, so look it up by the openclaw session id; fall
    // back to the shim's own session key in case the proxy keyed by that. All the
    // turn's calls are done by the time this fires, so the total is complete.
    if (!this.#costCorrelation) return;
    const cost = this.#takeSessionCost(sessionId) ?? this.#takeSessionCost(sessionKey);
    if (cost) foldSessionCost(totals, cost);
  }

  /**
   * Add one OpenRouter call's actual cost (read by the cost proxy off the
   * response) to the running total for `sessionId` — the session openclaw
   * stamped on the request. Summed across the turn's calls; claimed by `add`
   * when the turn's telemetry lands.
   */
  recordCost(sessionId: string, sample: CostSample): void {
    if (!this.#costCorrelation || !sessionId) return;
    const cur = this.#costBySession.get(sessionId) ?? {
      costUsd: 0,
      upstreamCostUsd: 0,
      hasUpstream: false,
      calls: 0,
    };
    cur.costUsd += sample.costUsd;
    if (typeof sample.upstreamCostUsd === "number") {
      cur.upstreamCostUsd += sample.upstreamCostUsd;
      cur.hasUpstream = true;
    }
    cur.calls += 1;
    // Re-insert to move it to the tail, so eviction below drops the least-recent.
    this.#costBySession.delete(sessionId);
    this.#costBySession.set(sessionId, cur);
    if (this.#costBySession.size > MAX_COST_SESSIONS) {
      const oldest = this.#costBySession.keys().next().value;
      if (oldest !== undefined) this.#costBySession.delete(oldest);
    }
  }

  /** Take and clear a session's accumulated cost, if any. */
  #takeSessionCost(key: string | undefined): SessionCost | null {
    if (!key) return null;
    const cost = this.#costBySession.get(key);
    if (!cost) return null;
    this.#costBySession.delete(key);
    return cost;
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
    // Actual OpenRouter charge for the turn, when the cost proxy correlated it.
    // `costed_calls` is the honest coverage: a turn where it trails model_calls
    // priced only some calls actually (the rest fall back to the estimate).
    cost_usd: totals.costUsd ?? null,
    costed_calls: totals.costedCalls ?? 0,
  });
}
