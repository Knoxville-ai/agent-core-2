import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentEnv } from "../env.js";
import {
  buildOpenclawConfig,
  DELEGATED_CREDS_PLUGIN_ID,
  LOCAL_OLLAMA_BASE_URL,
  parseExtraMcpServers,
  parseToolsDeny,
  REPORT_OUTCOME_PLUGIN_ID,
  writeOpenclawConfig,
} from "./render-workspace.js";

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

  it("hosted API model with a key → { apiKey } only, no baseUrl", () => {
    const config = buildOpenclawConfig(
      makeEnv({ LLM_PROVIDER: "anthropic", LLM_API_KEY: "sk-ant-123" }),
      "/ws",
    );
    expect(providers(config)).toEqual({ anthropic: { apiKey: "sk-ant-123" } });
  });

  it("external OpenAI-compatible endpoint → { apiKey, baseUrl }", () => {
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
      openai: { apiKey: "gsk_groqkey", baseUrl: "https://api.groq.com/openai/v1" },
    });
  });

  it("in-container ollama (no key, no base URL) → loopback baseUrl + placeholder key", () => {
    const config = buildOpenclawConfig(
      makeEnv({ LLM_PROVIDER: "ollama", LLM_MODEL: "llama3", LLM_API_KEY: "" }),
      "/ws",
    );
    expect(providers(config)).toEqual({
      ollama: { apiKey: "ollama", baseUrl: LOCAL_OLLAMA_BASE_URL },
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
      ollama: { apiKey: "ollama", baseUrl: "http://gpu-box.local:11434/v1" },
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

describe("writeOpenclawConfig", () => {
  it("writes a valid openclaw.json to the state dir before skills install", async () => {
    const dir = await mkdtemp(join(tmpdir(), "knox-openclaw-"));
    try {
      await writeOpenclawConfig(
        makeEnv({
          OPENCLAW_STATE_DIR: dir,
          LLM_PROVIDER: "openrouter",
          LLM_MODEL: "qwen/qwen3.7-plus",
          LLM_API_KEY: "sk-or-test",
        }),
      );
      const raw = await readFile(join(dir, "openclaw.json"), "utf8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      const agents = config.agents as { defaults: { model: { primary: string } } };
      // OpenRouter via the built-in provider: <provider>/<slug> primary, and a
      // providers.openrouter block carrying only the key (the built-in provider
      // supplies the endpoint — no baseUrl, which is the key openclaw rejects if
      // mis-cased).
      expect(agents.defaults.model.primary).toBe("openrouter/qwen/qwen3.7-plus");
      expect(providers(config)).toEqual({ openrouter: { apiKey: "sk-or-test" } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function mcpServers(config: Record<string, unknown>): Record<string, unknown> {
  return (config.mcp as { servers?: Record<string, unknown> } | undefined)?.servers ?? {};
}

describe("buildOpenclawConfig mcp.servers block", () => {
  it("no PLATFORM_MCP_URL and no extra servers → empty mcp.servers", () => {
    expect(mcpServers(buildOpenclawConfig(makeEnv({}), "/ws"))).toEqual({});
  });

  it("PLATFORM_MCP_URL → knoxville_platform with bearer auth", () => {
    const config = buildOpenclawConfig(
      makeEnv({
        PLATFORM_MCP_URL: "https://console.example/api/mcp",
        PLATFORM_API_TOKEN: "knox_agent_x",
      }),
      "/ws",
    );
    expect(mcpServers(config)).toEqual({
      knoxville_platform: {
        url: "https://console.example/api/mcp",
        transport: "streamable-http",
        headers: { Authorization: "Bearer knox_agent_x" },
      },
    });
  });

  it("OPENCLAW_MCP_SERVERS is merged alongside knoxville_platform", () => {
    const config = buildOpenclawConfig(
      makeEnv({
        PLATFORM_MCP_URL: "https://console.example/api/mcp",
        PLATFORM_API_TOKEN: "knox_agent_x",
        OPENCLAW_MCP_SERVERS: JSON.stringify({
          drivethru_mcp: {
            url: "https://odoo.example/drivethru_mcp/v1",
            transport: "streamable-http",
            headers: { Authorization: "Bearer inline-token" },
          },
        }),
      }),
      "/ws",
    );
    const servers = mcpServers(config);
    expect(Object.keys(servers).sort()).toEqual(["drivethru_mcp", "knoxville_platform"]);
    expect(servers.drivethru_mcp).toEqual({
      url: "https://odoo.example/drivethru_mcp/v1",
      transport: "streamable-http",
      headers: { Authorization: "Bearer inline-token" },
    });
  });

  it("a blob cannot override the reserved knoxville_platform entry", () => {
    const config = buildOpenclawConfig(
      makeEnv({
        PLATFORM_MCP_URL: "https://console.example/api/mcp",
        PLATFORM_API_TOKEN: "knox_agent_real",
        OPENCLAW_MCP_SERVERS: JSON.stringify({
          knoxville_platform: { url: "https://evil.example", transport: "streamable-http" },
        }),
      }),
      "/ws",
    );
    expect((mcpServers(config).knoxville_platform as { url: string }).url).toBe(
      "https://console.example/api/mcp",
    );
  });

  it("malformed OPENCLAW_MCP_SERVERS is ignored, not fatal", () => {
    const config = buildOpenclawConfig(makeEnv({ OPENCLAW_MCP_SERVERS: "{not json" }), "/ws");
    expect(mcpServers(config)).toEqual({});
  });
});

describe("buildOpenclawConfig platform plugins", () => {
  function plugins(config: Record<string, unknown>): {
    load?: { paths?: string[] };
    entries?: Record<string, unknown>;
  } {
    return (config.plugins as { load?: { paths?: string[] }; entries?: Record<string, unknown> }) ?? {};
  }

  it("wires both plugins (load paths + enabled entries) when PLATFORM_MCP_URL is set", () => {
    const config = buildOpenclawConfig(
      makeEnv({
        PLATFORM_MCP_URL: "https://console.example/api/mcp",
        PLATFORM_API_TOKEN: "knox_agent_x",
      }),
      "/ws",
    );
    const p = plugins(config);
    expect(p.entries?.[DELEGATED_CREDS_PLUGIN_ID]).toEqual({ enabled: true });
    expect(p.entries?.[REPORT_OUTCOME_PLUGIN_ID]).toEqual({ enabled: true });
    expect(
      (p.load?.paths ?? []).some((path) => path.endsWith("openclaw-plugins/delegated-credentials")),
    ).toBe(true);
    expect(
      (p.load?.paths ?? []).some((path) => path.endsWith("openclaw-plugins/report-outcome")),
    ).toBe(true);
  });

  it("does NOT wire the plugins when there is no PLATFORM_MCP_URL (no platform MCP reachable)", () => {
    const config = buildOpenclawConfig(makeEnv({}), "/ws");
    expect(config.plugins).toBeUndefined();
  });

  it("merges with an existing plugins block (Codex OAuth entries survive)", () => {
    const config = buildOpenclawConfig(
      makeEnv({
        LLM_PROVIDER: "openai",
        LLM_MODEL: "gpt-5.4",
        LLM_AUTH_MODE: "oauth",
        OPENCLAW_AUTH_PROFILE_SECRET_KEY: "seed",
        PLATFORM_MCP_URL: "https://console.example/api/mcp",
        PLATFORM_API_TOKEN: "knox_agent_x",
      }),
      "/ws",
    );
    const p = plugins(config);
    // Codex OAuth entries are preserved…
    expect(p.entries?.openai).toEqual({ enabled: true });
    expect(p.entries?.codex).toEqual({ enabled: true });
    // …alongside ours.
    expect(p.entries?.[DELEGATED_CREDS_PLUGIN_ID]).toEqual({ enabled: true });
    expect(p.entries?.[REPORT_OUTCOME_PLUGIN_ID]).toEqual({ enabled: true });
  });
});

describe("buildOpenclawConfig tools.exec.pathPrepend", () => {
  function pathPrepend(config: Record<string, unknown>): string[] {
    return (
      (config.tools as { exec?: { pathPrepend?: string[] } } | undefined)?.exec
        ?.pathPrepend ?? []
    );
  }

  it("prepends the exec shim then the skills venv (order matters)", () => {
    // The shim must resolve FIRST (it injects delegated creds then re-execs the
    // venv python3); the venv sits right behind it for requests/uv/pip.
    const config = buildOpenclawConfig(makeEnv({}), "/ws");
    expect(pathPrepend(config)).toEqual(["/opt/knox-exec-shim", "/opt/skills-venv/bin"]);
  });

  it("is present even with the platform MCP + delegation plugin wired", () => {
    const config = buildOpenclawConfig(
      makeEnv({
        PLATFORM_MCP_URL: "https://console.example/api/mcp",
        PLATFORM_API_TOKEN: "knox_agent_x",
      }),
      "/ws",
    );
    expect(pathPrepend(config)).toEqual(["/opt/knox-exec-shim", "/opt/skills-venv/bin"]);
  });
});

describe("buildOpenclawConfig tool policy (OPENCLAW_TOOLS_PROFILE / _DENY)", () => {
  function tools(config: Record<string, unknown>): Record<string, unknown> {
    return (config.tools as Record<string, unknown> | undefined) ?? {};
  }

  it("emits no profile/deny keys by default (unset → openclaw default, no restriction)", () => {
    const t = tools(buildOpenclawConfig(makeEnv({}), "/ws"));
    expect(t.profile).toBeUndefined();
    expect(t.deny).toBeUndefined();
    // …but the exec shim/venv PATH is always present.
    expect(t.exec).toBeDefined();
  });

  it("wires tools.profile when OPENCLAW_TOOLS_PROFILE is set", () => {
    const t = tools(buildOpenclawConfig(makeEnv({ OPENCLAW_TOOLS_PROFILE: "coding" }), "/ws"));
    expect(t.profile).toBe("coding");
  });

  it("wires tools.deny (parsed) when OPENCLAW_TOOLS_DENY is set", () => {
    const t = tools(
      buildOpenclawConfig(
        makeEnv({ OPENCLAW_TOOLS_DENY: "group:sessions, sessions_spawn subagents" }),
        "/ws",
      ),
    );
    expect(t.deny).toEqual(["group:sessions", "sessions_spawn", "subagents"]);
  });

  it("keeps the exec pathPrepend intact alongside a deny list", () => {
    const t = tools(
      buildOpenclawConfig(makeEnv({ OPENCLAW_TOOLS_DENY: "group:sessions" }), "/ws"),
    );
    expect((t.exec as { pathPrepend?: string[] }).pathPrepend).toEqual([
      "/opt/knox-exec-shim",
      "/opt/skills-venv/bin",
    ]);
    expect(t.deny).toEqual(["group:sessions"]);
  });
});

describe("parseToolsDeny", () => {
  it("empty / missing → []", () => {
    expect(parseToolsDeny(undefined)).toEqual([]);
    expect(parseToolsDeny("")).toEqual([]);
    expect(parseToolsDeny("   ")).toEqual([]);
  });

  it("splits on commas, spaces, and newlines", () => {
    expect(parseToolsDeny("a, b,c\n d")).toEqual(["a", "b", "c", "d"]);
  });

  it("de-duplicates while preserving first-seen order", () => {
    expect(parseToolsDeny("exec, group:sessions, exec, subagents")).toEqual([
      "exec",
      "group:sessions",
      "subagents",
    ]);
  });
});

describe("buildOpenclawConfig bootstrapMaxChars", () => {
  it("raises the SOUL truncation limit above openclaw's 12000 default", () => {
    const config = buildOpenclawConfig(makeEnv({}), "/ws");
    const defaults = (config.agents as { defaults: { bootstrapMaxChars?: number } }).defaults;
    expect(defaults.bootstrapMaxChars).toBeGreaterThan(12000);
  });
});

describe("parseExtraMcpServers", () => {
  it("expands ${VAR} references from the provided env source", () => {
    const { servers, error } = parseExtraMcpServers(
      JSON.stringify({
        drivethru_mcp: {
          url: "${ODOO_MCP_URL}",
          transport: "streamable-http",
          headers: { Authorization: "Bearer ${ODOO_MCP_TOKEN}" },
        },
      }),
      { ODOO_MCP_URL: "https://odoo.example/drivethru_mcp/v1", ODOO_MCP_TOKEN: "s3cret" },
    );
    expect(error).toBeUndefined();
    expect(servers.drivethru_mcp).toEqual({
      url: "https://odoo.example/drivethru_mcp/v1",
      transport: "streamable-http",
      headers: { Authorization: "Bearer s3cret" },
    });
  });

  it("empty / missing blob → no servers, no error", () => {
    expect(parseExtraMcpServers(undefined)).toEqual({ servers: {} });
    expect(parseExtraMcpServers("   ")).toEqual({ servers: {} });
  });

  it("non-object JSON → error, no servers", () => {
    const { servers, error } = parseExtraMcpServers("[1,2,3]");
    expect(servers).toEqual({});
    expect(error).toBeTruthy();
  });

  it("skips non-object server entries", () => {
    const { servers } = parseExtraMcpServers(
      JSON.stringify({ good: { url: "https://x" }, bad: "nope" }),
      {},
    );
    expect(Object.keys(servers)).toEqual(["good"]);
  });
});
