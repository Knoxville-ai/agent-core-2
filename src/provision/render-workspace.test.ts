import { describe, expect, it } from "vitest";

import type { AgentEnv } from "../env.js";
import { buildOpenclawConfig, LOCAL_OLLAMA_BASE_URL } from "./render-workspace.js";

/** Minimal AgentEnv with sane defaults; override per-case. */
function makeEnv(overrides: Partial<AgentEnv>): AgentEnv {
  return {
    AGENT_UID: "0123456789abcdef",
    AGENT_ORG: "acme",
    AGENT_ROLE: "generic",
    SUPABASE_JWT_SECRET: "secret",
    MESSAGING_ENABLED: true,
    OPENCLAW_GATEWAY_TOKEN: "0123456789abcdef",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "svc",
    LLM_PROVIDER: "anthropic",
    LLM_MODEL: "claude-opus-4-8",
    LLM_API_KEY: "",
    LLM_AUTH_MODE: "api_key",
    AGENT_HTTP_PORT: 8080,
    OPENCLAW_GATEWAY_PORT: 18789,
    OPENCLAW_STATE_DIR: "/home/agent/.openclaw",
    LOG_LEVEL: "info",
    ...overrides,
  } as AgentEnv;
}

function providers(config: Record<string, unknown>): Record<string, unknown> {
  return (config.models as { providers?: Record<string, unknown> } | undefined)
    ?.providers ?? {};
}

describe("buildOpenclawConfig model provider block", () => {
  it("sets model.primary to <provider>/<model>", () => {
    const config = buildOpenclawConfig(
      makeEnv({ LLM_PROVIDER: "openai", LLM_MODEL: "gpt-5.4-mini" }),
      "/ws",
    );
    const agents = config.agents as { defaults: { model: { primary: string } } };
    expect(agents.defaults.model.primary).toBe("openai/gpt-5.4-mini");
  });

  it("hosted API model with a key → { apiKey } only, no baseURL", () => {
    const config = buildOpenclawConfig(
      makeEnv({ LLM_PROVIDER: "anthropic", LLM_API_KEY: "sk-ant-123" }),
      "/ws",
    );
    expect(providers(config)).toEqual({ anthropic: { apiKey: "sk-ant-123" } });
  });

  it("external OpenAI-compatible endpoint → { apiKey, baseURL }", () => {
    const config = buildOpenclawConfig(
      makeEnv({
        LLM_PROVIDER: "openai",
        LLM_MODEL: "llama-3.1-8b-instant",
        LLM_API_KEY: "gsk_groqkey",
        LLM_BASE_URL: "https://api.groq.com/openai/v1",
      }),
      "/ws",
    );
    expect(providers(config)).toEqual({
      openai: { apiKey: "gsk_groqkey", baseURL: "https://api.groq.com/openai/v1" },
    });
  });

  it("in-container ollama (no key, no base URL) → loopback baseURL + placeholder key", () => {
    const config = buildOpenclawConfig(
      makeEnv({ LLM_PROVIDER: "ollama", LLM_MODEL: "llama3", LLM_API_KEY: "" }),
      "/ws",
    );
    expect(providers(config)).toEqual({
      ollama: { apiKey: "ollama", baseURL: LOCAL_OLLAMA_BASE_URL },
    });
  });

  it("self-hosted ollama box → explicit LLM_BASE_URL overrides the loopback default", () => {
    const config = buildOpenclawConfig(
      makeEnv({
        LLM_PROVIDER: "ollama",
        LLM_MODEL: "mistral",
        LLM_BASE_URL: "http://gpu-box.local:11434/v1",
      }),
      "/ws",
    );
    expect(providers(config)).toEqual({
      ollama: { apiKey: "ollama", baseURL: "http://gpu-box.local:11434/v1" },
    });
  });

  it("hosted model with no key and no base URL → no providers block", () => {
    const config = buildOpenclawConfig(
      makeEnv({ LLM_PROVIDER: "anthropic", LLM_API_KEY: "" }),
      "/ws",
    );
    expect(config.models).toBeUndefined();
  });

  it("oauth mode ignores provider block and wires codex auth instead", () => {
    const config = buildOpenclawConfig(
      makeEnv({
        LLM_PROVIDER: "openai",
        LLM_MODEL: "gpt-5.4",
        LLM_AUTH_MODE: "oauth",
        OPENCLAW_AUTH_PROFILE_SECRET_KEY: "seed",
      }),
      "/ws",
    );
    expect(config.models).toBeUndefined();
    expect(config.auth).toBeDefined();
    expect(config.plugins).toBeDefined();
  });
});
