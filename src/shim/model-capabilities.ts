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

/**
 * Providers that are routers, not model owners: their model ids carry the
 * upstream provider as a prefix (`anthropic/claude-sonnet-4-6`,
 * `openai/gpt-5.4`, `qwen/qwen3.7-plus`).
 *
 * Without this, every model on such a provider missed the table AND every
 * heuristic — all of which key on the upstream provider name — and fell to
 * `DEFAULT`, i.e. text-only. On a fleet whose default is
 * `LLM_PROVIDER=openrouter`, that silently dropped image attachments for any
 * model whose console catalog row left `multimodal` NULL (the case that means
 * "use the static table").
 */
const ROUTER_PROVIDERS = new Set(["openrouter"]);

/**
 * How many router prefixes to unwrap. One is all a real ref needs
 * (`openrouter` + `anthropic/claude-…`); the bound is explicit so a
 * pathological id like `openrouter/openrouter/…` terminates by rule rather
 * than by happening to run out of string.
 */
const MAX_ROUTER_HOPS = 1;

export function lookupCapabilities(
  provider: string,
  model: string,
  hops = 0,
): ModelCapabilities {
  const p = provider.trim().toLowerCase();
  const m = model.trim();
  const exact = MODELS[p]?.[m];
  if (exact) return exact;

  // Unwrap the router hop: resolve against the upstream provider the model id
  // names. A ref with no prefix falls through to the conservative default
  // rather than guessing.
  if (ROUTER_PROVIDERS.has(p) && hops < MAX_ROUTER_HOPS) {
    const slash = m.indexOf("/");
    if (slash > 0 && slash < m.length - 1) {
      return lookupCapabilities(m.slice(0, slash), m.slice(slash + 1), hops + 1);
    }
  }

  return heuristicCapabilities(p, m) ?? DEFAULT;
}

/**
 * Effective capabilities: an explicit override (from the console model
 * catalog, delivered as LLM_MULTIMODAL / LLM_FILE_INPUT) wins; an undefined
 * override falls back to the static lookupCapabilities table above. This is
 * how a model the static table doesn't know about — e.g. an OpenRouter vision
 * model provisioned behind LLM_PROVIDER=openai — still gets its images
 * inlined. Mirror of the console's resolveModelCapabilities; keep precedence
 * identical.
 */
export function resolveCapabilities(
  provider: string,
  model: string,
  overrides: { multimodal?: boolean; fileInput?: boolean } = {},
): ModelCapabilities {
  const base = lookupCapabilities(provider, model);
  return {
    multimodal: overrides.multimodal ?? base.multimodal,
    fileInput: overrides.fileInput ?? base.fileInput,
  };
}

/**
 * Split a `"<provider>/<model>"` ref on the FIRST slash.
 *
 * Matches openclaw's own `x-openclaw-model` parsing, so
 * `"openrouter/qwen/qwen3.7-plus"` is provider `openrouter`, model
 * `qwen/qwen3.7-plus` — the router prefix stays on the model id, which is what
 * `lookupCapabilities` then unwraps.
 */
export function splitModelRef(
  ref: string,
): { provider: string; model: string } | null {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
  };
}

/**
 * Capabilities for the model that will ACTUALLY run a turn.
 *
 * Both turn paths must answer this the same way, and they were answering it in
 * two places: the task path followed its per-request override, the chat path
 * always read the container default. That is correct today only because the
 * chat path has no override to follow — the moment it gains one, the two
 * silently disagree and attachments are decided for the wrong model. One
 * helper so that cannot happen.
 *
 * The env flags (`LLM_MULTIMODAL` / `LLM_FILE_INPUT`) describe the container
 * default, so they are deliberately NOT applied to an override.
 */
export function capabilitiesForTurn(opts: {
  defaultProvider: string;
  defaultModel: string;
  defaultOverrides?: { multimodal?: boolean; fileInput?: boolean };
  /** `"<provider>/<model>"` when this turn pinned one; null/undefined otherwise. */
  modelRef?: string | null;
}): ModelCapabilities {
  const override = opts.modelRef ? splitModelRef(opts.modelRef) : null;
  if (override) return resolveCapabilities(override.provider, override.model);
  return resolveCapabilities(
    opts.defaultProvider,
    opts.defaultModel,
    opts.defaultOverrides ?? {},
  );
}
