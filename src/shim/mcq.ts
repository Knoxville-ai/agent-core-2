import { randomUUID } from "node:crypto";

/**
 * Structured multiple-choice question ("MCQ") support.
 *
 * The agent asks the party it is currently serving — a human over webchat, or a
 * calling agent over A2A — a small, discrete decision by emitting a single fenced
 * ```knox:ask block as its reply. The shim (routes-messages.ts) detects that
 * block in the streamed text, suppresses the raw fence from the visible token
 * stream, emits a `question` SSE frame, and persists the assistant row as the
 * normalized `mcq` JSON below (reusing the console's existing "structured message
 * = JSON in content" rendering convention — no schema migration).
 *
 * The shape mirrors Claude Code's AskUserQuestion tool: 1–4 questions, each with a
 * short header, the full prompt, 2–4 options (label + description), optional
 * multi-select, and an always-available free-text "Other".
 *
 * Because the SSE stream is consumed identically by a human's browser and by the
 * platform A2A bridge, the SAME emission mechanism serves both audiences — the
 * browser renders a widget; the bridge hands the options back to the calling
 * agent as structured content. There is nothing audience-specific here.
 */

export interface McqOption {
  /** 1–5 words the user selects. */
  label: string;
  /** What choosing this option means / its implications. */
  description?: string;
}

export interface McqQuestion {
  /** Very short chip label (≤12 chars), e.g. "Backorder?". */
  header: string;
  /** The complete question. */
  question: string;
  /** Allow more than one option to be selected. */
  multiSelect: boolean;
  /** 2–4 options. */
  options: McqOption[];
}

export interface Mcq {
  type: "mcq";
  version: 1;
  /** Stable id correlating the question with its answer. */
  question_id: string;
  questions: McqQuestion[];
  /** Whether the free-text "Other" escape hatch is offered (default true). */
  allowOther: boolean;
}

/**
 * The fence opener the model uses. We trigger detection on the shorter "```knox"
 * so minor info-string variants (`knox:ask`, `knox-ask`) are still caught and
 * suppressed from the visible stream; the parser is lenient about the rest.
 */
const TRIGGER = "```knox";

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Derive a compact header from the question text when the model omits one. */
function deriveHeader(question: string): string {
  const words = question
    .replace(/[?.!]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");
  return (words || "Question").slice(0, 12);
}

/**
 * Validate + normalize a parsed object into an `Mcq`, or return null if it is not
 * a well-formed question. Enforces the AskUserQuestion bounds (1–4 questions, 2–4
 * options each) and clamps rather than rejecting where a clamp is unambiguous.
 */
function normalizeMcq(obj: unknown): Mcq | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const rawQuestions = Array.isArray(o.questions) ? o.questions : null;
  if (!rawQuestions || rawQuestions.length === 0) return null;

  const questions: McqQuestion[] = [];
  for (const rq of rawQuestions.slice(0, 4)) {
    if (!rq || typeof rq !== "object") continue;
    const q = rq as Record<string, unknown>;
    const question = asString(q.question).trim();
    if (!question) continue;

    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const options: McqOption[] = [];
    for (const ro of rawOptions.slice(0, 4)) {
      if (!ro || typeof ro !== "object") continue;
      const oo = ro as Record<string, unknown>;
      const label = asString(oo.label).trim();
      if (!label) continue;
      const description = asString(oo.description).trim();
      options.push(description ? { label, description } : { label });
    }
    // A meaningful multiple choice needs at least two options.
    if (options.length < 2) continue;

    let header = asString(q.header).trim();
    if (!header) header = deriveHeader(question);
    if (header.length > 12) header = header.slice(0, 12).trim();

    questions.push({
      header,
      question,
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  if (questions.length === 0) return null;

  return {
    type: "mcq",
    version: 1,
    question_id: randomUUID(),
    questions,
    allowOther: o.allowOther === false ? false : true,
  };
}

/**
 * Parse a completed model reply that contains a ```knox:ask fence into an `Mcq`,
 * or null if there is no block / it can't be validated. Lenient about the info
 * string and surrounding prose; strict about the payload shape.
 */
export function parseKnoxAsk(raw: string): Mcq | null {
  const start = raw.indexOf(TRIGGER);
  if (start === -1) return null;
  // The JSON begins after the fence's info-string line.
  const afterFence = raw.indexOf("\n", start);
  if (afterFence === -1) return null;
  let inner = raw.slice(afterFence + 1);
  const close = inner.lastIndexOf("```");
  if (close !== -1) inner = inner.slice(0, close);
  inner = inner.trim();
  if (!inner) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(inner);
  } catch {
    return null;
  }
  return normalizeMcq(obj);
}

/**
 * If a stored assistant `content` string is a serialized `mcq` payload, parse it
 * back. Used when rebuilding model history so the agent sees a clean textual
 * rendering of a question it previously asked (via `mcqToModelText`) rather than
 * raw JSON.
 */
export function parseStoredMcq(content: string): Mcq | null {
  const t = content.trim();
  if (!t.startsWith("{") || !t.includes('"type"')) return null;
  try {
    const obj = JSON.parse(t) as Record<string, unknown>;
    if (obj && obj.type === "mcq" && Array.isArray(obj.questions)) {
      return normalizeStored(obj);
    }
  } catch {
    /* not JSON — treat as plain text */
  }
  return null;
}

/** Re-hydrate a stored mcq without minting a new id (keeps the persisted one). */
function normalizeStored(obj: Record<string, unknown>): Mcq | null {
  const base = normalizeMcq(obj);
  if (!base) return null;
  const id = asString(obj.question_id).trim();
  return { ...base, question_id: id || base.question_id };
}

/**
 * Render an `Mcq` as a concise text block for inclusion in model history, so a
 * subsequent turn reads a clean summary of the question it asked rather than the
 * serialized JSON.
 */
export function mcqToModelText(mcq: Mcq): string {
  const lines: string[] = [
    "[You asked a multiple-choice question and are now reading the answer.]",
  ];
  for (const q of mcq.questions) {
    lines.push(`Question (${q.header}): ${q.question}`);
    for (const opt of q.options) {
      lines.push(
        `  - ${opt.label}${opt.description ? ` — ${opt.description}` : ""}`,
      );
    }
    if (mcq.allowOther) lines.push("  - Other (free text)");
  }
  return lines.join("\n");
}

/**
 * Streaming filter that hides a ```knox:ask block from the visible token stream
 * while it is being generated. Feed each token to `push()` and forward whatever
 * visible text it returns; once the fence opener appears, everything from it
 * onward is withheld and captured for post-stream parsing. Withholds a trailing
 * partial-marker suffix so the fence can never leak one token early.
 */
export class SentinelFilter {
  private raw = "";
  /** Index up to which `raw` has been emitted as visible text. */
  private emitted = 0;
  private triggerAt = -1;

  /** Feed a token; returns the visible text to stream (possibly ""). */
  push(token: string): string {
    this.raw += token;
    if (this.triggerAt !== -1) return "";

    const idx = this.raw.indexOf(TRIGGER);
    if (idx !== -1) {
      this.triggerAt = idx;
      const out = idx > this.emitted ? this.raw.slice(this.emitted, idx) : "";
      this.emitted = this.raw.length;
      return out;
    }

    // Hold back a suffix that could be the start of the trigger marker.
    const safeEnd = this.raw.length - this.trailingPrefixLen();
    if (safeEnd > this.emitted) {
      const out = this.raw.slice(this.emitted, safeEnd);
      this.emitted = safeEnd;
      return out;
    }
    return "";
  }

  /**
   * Flush any visible text still held back after the stream ends (only happens
   * when the trigger never completed — e.g. a trailing "``" that wasn't a fence).
   */
  flush(): string {
    if (this.triggerAt !== -1) return "";
    if (this.raw.length > this.emitted) {
      const out = this.raw.slice(this.emitted);
      this.emitted = this.raw.length;
      return out;
    }
    return "";
  }

  get sawSentinel(): boolean {
    return this.triggerAt !== -1;
  }

  /** The withheld fence block (from the trigger onward), for fallback emission. */
  suppressedText(): string {
    return this.triggerAt === -1 ? "" : this.raw.slice(this.triggerAt);
  }

  private trailingPrefixLen(): number {
    const max = Math.min(TRIGGER.length - 1, this.raw.length);
    for (let k = max; k > 0; k--) {
      if (this.raw.endsWith(TRIGGER.slice(0, k))) return k;
    }
    return 0;
  }
}
