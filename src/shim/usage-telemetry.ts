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
  /** OpenRouter `usage.prompt_tokens` — cache-INCLUSIVE, the join key's input side. */
  promptTokens: number;
  /** OpenRouter `usage.completion_tokens` — the join key's output side. */
  completionTokens: number;
  /** Response model id — a soft disambiguator on the correlation. */
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
 * Cap on each correlation buffer. A matched pair is popped within milliseconds
 * (the proxy and the plugin observe the same call almost simultaneously), so
 * these stay near-empty in practice. The cap only matters as a leak backstop:
 * a cost the plugin never reports (or a call the proxy never sees) would
 * otherwise sit here forever. When over the cap we drop the OLDEST unmatched
 * entry — losing at most one call's cost, never unbounded memory.
 */
const MAX_PENDING_CORRELATION = 512;

/** Correlation key: the token counts are identical on both sides of the join —
 *  OpenRouter's `prompt_tokens` == the plugin's `input + cache_read`, and its
 *  `completion_tokens` == the plugin's `output`. Two truly-simultaneous calls
 *  with identical counts can swap, but their costs are then identical too, so
 *  the attributed dollar figure is unaffected. */
function tupleKey(promptTokens: number, completionTokens: number): string {
  return `${promptTokens}:${completionTokens}`;
}

/** Pop the oldest value queued under `key`, cleaning up the key when it drains. */
function shiftFrom<T>(map: Map<string, T[]>, key: string): T | undefined {
  const queue = map.get(key);
  if (!queue || queue.length === 0) return undefined;
  const value = queue.shift();
  if (queue.length === 0) map.delete(key);
  return value;
}

/** Append `value` under `key`, evicting the oldest entry across the whole map
 *  once it exceeds `cap`. FIFO so identical repeated calls stay in order. */
function pushInto<T>(map: Map<string, T[]>, key: string, value: T, cap: number): void {
  const queue = map.get(key);
  if (queue) queue.push(value);
  else map.set(key, [value]);
  let total = 0;
  for (const q of map.values()) total += q.length;
  if (total <= cap) return;
  // Over the cap: drop the oldest entry in insertion order. Map iteration is
  // insertion-ordered, so the first non-empty queue holds the oldest value.
  for (const [k, q] of map) {
    if (q.length > 0) {
      q.shift();
      if (q.length === 0) map.delete(k);
      break;
    }
  }
}

/** Fold one correlated cost into a turn's running totals. */
function foldCost(totals: CacheUsageTotals, cost: CostSample): void {
  totals.costUsd = (totals.costUsd ?? 0) + cost.costUsd;
  if (typeof cost.upstreamCostUsd === "number") {
    totals.upstreamCostUsd = (totals.upstreamCostUsd ?? 0) + cost.upstreamCostUsd;
  }
  totals.costedCalls = (totals.costedCalls ?? 0) + 1;
}

export class UsageAccumulator {
  #bySession = new Map<string, CacheUsageTotals>();
  /** Costs the proxy has reported but no plugin sample has claimed yet. */
  #pendingCosts = new Map<string, CostSample[]>();
  /** Sessions whose call arrived before its cost — the reverse race. Each entry
   *  is a sessionKey awaiting a cost for the given token tuple. */
  #pendingUsage = new Map<string, string[]>();
  /** Off until the cost proxy starts. While off, `add` never buffers pending
   *  usage, so a deployment with no proxy (or a non-OpenRouter provider) does
   *  no correlation work and cannot accumulate unmatched waiters. */
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

    // Correlate this call with the actual cost the proxy read for it. The
    // plugin's `input` is cache-EXCLUSIVE, so add cache_read back to recover
    // OpenRouter's cache-inclusive `prompt_tokens` — the value the proxy keyed
    // its cost by.
    if (!this.#costCorrelation) return;
    const key = tupleKey(sample.input + sample.cache_read, sample.output);
    const cost = shiftFrom(this.#pendingCosts, key);
    if (cost) {
      foldCost(totals, cost);
    } else {
      // Cost hasn't arrived yet (rare — the proxy usually wins the race).
      // Park this session so a late cost can still find it.
      pushInto(this.#pendingUsage, key, sessionKey, MAX_PENDING_CORRELATION);
    }
  }

  /**
   * Record one call's actual cost, read by the cost proxy off OpenRouter's
   * response. Matched to a live turn by token tuple — either now (the plugin
   * sample already landed) or later, when it does.
   */
  recordCost(sample: CostSample): void {
    const key = tupleKey(sample.promptTokens, sample.completionTokens);
    const waitingSessionKey = shiftFrom(this.#pendingUsage, key);
    if (waitingSessionKey) {
      const totals = this.#bySession.get(waitingSessionKey);
      // The turn may have drained already (a straggler cost). Dropping it is
      // correct — the turn is closed and its row written.
      if (totals) foldCost(totals, sample);
      return;
    }
    pushInto(this.#pendingCosts, key, sample, MAX_PENDING_CORRELATION);
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
