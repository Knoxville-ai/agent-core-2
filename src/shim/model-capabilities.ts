/**
 * Static lookup: which (provider, model) pairs support image / file inputs.
 *
 * Port of app/messaging/model_capabilities.py — keep this in sync with
 * the Python file and the console's src/lib/model-capabilities.ts.
 *
 * Unknown models default to text-only; the messaging API returns a
 * system_generated note when attachments can't be forwarded.
 */

export interface ModelCapabilities {
  multimodal: boolean;
  fileInput: boolean;
}

const MODELS: Record<string, Record<string, ModelCapabilities>> = {
  openai: {
    "gpt-4o": { multimodal: true, fileInput: false },
    "gpt-4o-mini": { multimodal: true, fileInput: false },
    "gpt-4.1": { multimodal: true, fileInput: false },
    "gpt-4.1-mini": { multimodal: true, fileInput: false },
    "gpt-4.1-nano": { multimodal: true, fileInput: false },
    "gpt-5": { multimodal: true, fileInput: false },
    "gpt-5-mini": { multimodal: true, fileInput: false },
    "gpt-5.4": { multimodal: true, fileInput: false },
    "gpt-5.4-mini": { multimodal: true, fileInput: false },
    "o3-mini": { multimodal: false, fileInput: false },
  },
  anthropic: {
    "claude-sonnet-4-20250514": { multimodal: true, fileInput: false },
    "claude-sonnet-4-6": { multimodal: true, fileInput: false },
    "claude-opus-4-20250514": { multimodal: true, fileInput: false },
    "claude-opus-4-8": { multimodal: true, fileInput: false },
    "claude-haiku-4-5-20251001": { multimodal: true, fileInput: false },
  },
  google: {
    "gemini-2.0-flash": { multimodal: true, fileInput: false },
  },
  ollama: {},
};

const DEFAULT: ModelCapabilities = { multimodal: false, fileInput: false };

/**
 * Heuristic fallback for models not in the static table. The explicit table
 * above lags new releases (gpt-5.4-mini shipped multimodal but wasn't listed,
 * so images got silently dropped), so we infer vision support from known
 * model *families* whose every current member accepts image input. Stays
 * conservative: only families that uniformly ship vision, so we never inline
 * an image into a text-only model and trigger an upstream 400.
 *
 * `fileInput` (PDF/doc ingestion) stays false — no provider path for it is
 * wired up yet, so inferring it would be wrong.
 */
function heuristicCapabilities(
  provider: string,
  model: string,
): ModelCapabilities | null {
  if (provider === "openai") {
    // gpt-4o*, gpt-4.1*, gpt-5* (incl. gpt-5.4-mini) are vision-capable. The
    // o-series is mixed (o3-mini is text-only), so leave it to the table.
    if (/^gpt-4o\b/.test(model) || /^gpt-4\.1\b/.test(model) || /^gpt-5\b/.test(model)) {
      return { multimodal: true, fileInput: false };
    }
  }
  if (provider === "anthropic") {
    // Every Claude 3+ model accepts images.
    if (model.startsWith("claude-")) return { multimodal: true, fileInput: false };
  }
  if (provider === "google") {
    // Gemini 1.5 / 2.x are all multimodal.
    if (model.startsWith("gemini-")) return { multimodal: true, fileInput: false };
  }
  return null;
}

export function lookupCapabilities(
  provider: string,
  model: string,
): ModelCapabilities {
  const p = provider.trim().toLowerCase();
  const m = model.trim();
  const exact = MODELS[p]?.[m];
  if (exact) return exact;
  return heuristicCapabilities(p, m) ?? DEFAULT;
}
