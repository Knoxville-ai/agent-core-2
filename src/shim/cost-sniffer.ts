import type { CostSample } from "./usage-telemetry.js";

/**
 * Pure, stream-free parser that extracts OpenRouter's `usage.cost` from a chat
 * completion response body. Kept separate from cost-proxy.ts so the parsing —
 * the only part with real logic — is unit-testable without sockets.
 *
 * Two shapes, both handled:
 *   - Streaming (`text/event-stream`): the usage arrives on a trailing SSE
 *     `data:` frame (often with empty `choices`). We scan frames as their lines
 *     complete and keep the LAST one that carried a cost, so content deltas are
 *     parsed and discarded — memory stays bounded to a partial line.
 *   - Non-streaming (`application/json`): the usage is in `body.usage`. We
 *     buffer the body (capped) and parse once on finish.
 *
 * Everything is defensive: this reads an untrusted network body on the
 * inference hot path via a tee, so any malformed input must yield `null`, never
 * throw. The caller additionally wraps push/finish, but we don't rely on that.
 */

/** Hard caps so a body that never terminates cannot grow memory without bound. */
const MAX_SSE_LINE_BYTES = 1_000_000;
const MAX_JSON_BODY_BYTES = 8_000_000;

export interface UsageCostParser {
  /** Feed the next slice of response bytes. */
  push(chunk: Buffer): void;
  /** Signal end of body; returns the correlated cost sample, or null. */
  finish(): CostSample | null;
  /**
   * What the response's usage frame actually contained — for one-shot diagnosis
   * of "does OpenRouter return cost here?". Field NAMES only (never values or any
   * message content). `sawUsage` false means no usage frame was seen at all.
   */
  diagnostics(): { sawUsage: boolean; hadCost: boolean; keys: string[] };
}

/** Coerce to a finite number, or undefined. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Pull a CostSample out of a parsed chat-completion frame/body. Requires an
 * actual `usage.cost` (a real number, so a genuine $0 free call still records)
 * plus the token counts we correlate by. Returns null otherwise.
 */
export function costSampleFromPayload(payload: unknown): CostSample | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  const usage = obj.usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;

  const costUsd = finiteNumber(u.cost);
  const promptTokens = finiteNumber(u.prompt_tokens);
  const completionTokens = finiteNumber(u.completion_tokens);
  if (costUsd === undefined || promptTokens === undefined || completionTokens === undefined) {
    return null;
  }

  const sample: CostSample = { costUsd, promptTokens, completionTokens };

  const details = u.cost_details;
  if (details && typeof details === "object") {
    const upstream = finiteNumber((details as Record<string, unknown>).upstream_inference_cost);
    if (upstream !== undefined) sample.upstreamCostUsd = upstream;
  }
  if (typeof obj.model === "string" && obj.model) sample.model = obj.model;
  if (typeof obj.id === "string" && obj.id) sample.generationId = obj.id;
  return sample;
}

/** Decide SSE vs JSON from the content-type, falling back to a byte peek. */
function looksLikeSse(contentType: string | undefined, firstBytes: string): boolean {
  if (contentType && contentType.toLowerCase().includes("text/event-stream")) return true;
  if (contentType && contentType.toLowerCase().includes("application/json")) return false;
  // No decisive content-type: an SSE body opens with a `data:`/`event:`/`:` line.
  const trimmed = firstBytes.trimStart();
  return trimmed.startsWith("data:") || trimmed.startsWith("event:") || trimmed.startsWith(":");
}

export function sniffUsageCost(contentType: string | undefined): UsageCostParser {
  let mode: "sse" | "json" | "unknown" = contentType
    ? looksLikeSse(contentType, "")
      ? "sse"
      : "json"
    : "unknown";

  // SSE state: an accumulating line buffer + the best cost seen so far.
  let lineBuf = "";
  let best: CostSample | null = null;
  let overflowed = false;

  // JSON state: the accumulating body.
  let jsonBuf = "";

  // Diagnostics: the field NAMES of the last usage frame seen, and whether it
  // carried a numeric `cost`. Names only — never values or message content.
  const diag = { sawUsage: false, hadCost: false, keys: [] as string[] };
  function noteUsage(frame: unknown): void {
    if (!frame || typeof frame !== "object") return;
    const usage = (frame as Record<string, unknown>).usage;
    if (!usage || typeof usage !== "object") return;
    diag.sawUsage = true;
    diag.keys = Object.keys(usage as Record<string, unknown>);
    diag.hadCost = typeof (usage as Record<string, unknown>).cost === "number";
  }

  function handleSseLine(line: string): void {
    const trimmed = line.trimEnd();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice("data:".length).trim();
    if (!data || data === "[DONE]") return;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    noteUsage(frame);
    const sample = costSampleFromPayload(frame);
    if (sample) best = sample; // keep the last cost-bearing frame
  }

  function pushSse(text: string): void {
    if (overflowed) return;
    lineBuf += text;
    let nl: number;
    while ((nl = lineBuf.indexOf("\n")) !== -1) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      handleSseLine(line);
    }
    if (lineBuf.length > MAX_SSE_LINE_BYTES) {
      // A single line never terminated — give up rather than grow unbounded.
      overflowed = true;
      lineBuf = "";
    }
  }

  return {
    push(chunk: Buffer): void {
      const text = chunk.toString("utf8");
      if (mode === "unknown") {
        mode = looksLikeSse(contentType, text) ? "sse" : "json";
      }
      if (mode === "sse") {
        pushSse(text);
      } else {
        if (overflowed) return;
        jsonBuf += text;
        if (jsonBuf.length > MAX_JSON_BODY_BYTES) {
          overflowed = true;
          jsonBuf = "";
        }
      }
    },
    finish(): CostSample | null {
      if (mode === "sse") {
        if (lineBuf.length > 0) handleSseLine(lineBuf); // trailing unterminated line
        return best;
      }
      if (overflowed || jsonBuf.trim().length === 0) return null;
      try {
        const parsed = JSON.parse(jsonBuf);
        noteUsage(parsed);
        return costSampleFromPayload(parsed);
      } catch {
        return null;
      }
    },
    diagnostics() {
      return { sawUsage: diag.sawUsage, hadCost: diag.hadCost, keys: diag.keys };
    },
  };
}
