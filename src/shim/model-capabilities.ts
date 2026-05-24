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
    "o3-mini": { multimodal: false, fileInput: false },
  },
  anthropic: {
    "claude-sonnet-4-20250514": { multimodal: true, fileInput: false },
    "claude-sonnet-4-6": { multimodal: true, fileInput: false },
    "claude-opus-4-20250514": { multimodal: true, fileInput: false },
    "claude-haiku-4-5-20251001": { multimodal: true, fileInput: false },
  },
  google: {
    "gemini-2.0-flash": { multimodal: true, fileInput: false },
  },
  ollama: {},
};

const DEFAULT: ModelCapabilities = { multimodal: false, fileInput: false };

export function lookupCapabilities(
  provider: string,
  model: string,
): ModelCapabilities {
  const byProvider = MODELS[provider.trim().toLowerCase()] ?? {};
  return byProvider[model.trim()] ?? DEFAULT;
}
