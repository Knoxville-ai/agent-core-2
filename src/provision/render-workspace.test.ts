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
  TASK_PROGRESS_PLUGIN_ID,
  USAGE_TELEMETRY_PLUGIN_ID,
  parseToolList,
  resolveHeartbeatEvery,
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

  it("OpenRouter + cost tracking → proxy baseUrl + models[] compat overlay (prompt_cache_key)", () => {
    const config = buildOpenclawConfig(
      makeEnv({
        LLM_PROVIDER: "openrouter",
        LLM_MODEL: "qwen/qwen3.7-plus",
        LLM_API_KEY: "sk-or-test",
        OPENROUTER_COST_TRACKING: true,
        OPENROUTER_COST_PROXY_PORT: 18790,
      }),
      "/ws",
    );
    // The provider is pointed at the in-shim cost proxy, and the primary model
    // carries `compat.supportsPromptCacheKey: true` — the flag that makes openclaw
    // stamp the session UUID onto each call so the proxy can attribute cost. The
    // overlay adds ONLY id/name/compat; apiKey + baseUrl stay on the provider.
    expect(providers(config)).toEqual({
      openrouter: {
        apiKey: "sk-or-test",
        baseUrl: "http://127.0.0.1:18790/api/v1",
        models: [
          {
            id: "qwen/qwen3.7-plus",
            name: "qwen/qwen3.7-plus",
            compat: { supportsPromptCacheKey: true },
          },
        ],
      },
    });
  });

  it("covers every model a task may pin, not just the container default", () => {
    // A routine can pin any catalog model, which reaches openclaw as
    // `x-openclaw-model`. A pinned model absent from this overlay gets no
    // `prompt_cache_key`, so the cost proxy has nothing to correlate and its
    // turns silently record no actual cost.
    const config = buildOpenclawConfig(
      makeEnv({
        LLM_PROVIDER: "openrouter",
        LLM_MODEL: "qwen/qwen3.7-plus",
        LLM_API_KEY: "sk-or-test",
        OPENROUTER_COST_TRACKING: true,
        OPENROUTER_COST_PROXY_PORT: 18790,
        LLM_COST_TRACKED_MODELS: "anthropic/claude-sonnet-4-6, openai/gpt-5.4",
      }),
      "/ws",
    );
    expect(
      (providers(config).openrouter as { models: Array<{ id: string }> }).models.map(
        (m) => m.id,
      ),
    ).toEqual(["qwen/qwen3.7-plus", "anthropic/claude-sonnet-4-6", "openai/gpt-5.4"]);
  });

  it("keeps the default first, dedupes, and strips a provider prefix", () => {
    // Default first so the common single-model config renders byte-identically
    // to before this env var existed. The prefix strip is because the overlay
    // keys on the BARE id — a pasted full ref would otherwise never match.
    const config = buildOpenclawConfig(
      makeEnv({
        LLM_PROVIDER: "openrouter",
        LLM_MODEL: "qwen/qwen3.7-plus",
        LLM_API_KEY: "sk-or-test",
        OPENROUTER_COST_TRACKING: true,
        OPENROUTER_COST_PROXY_PORT: 18790,
        LLM_COST_TRACKED_MODELS:
          "openrouter/anthropic/claude-sonnet-4-6 qwen/qwen3.7-plus anthropic/claude-sonnet-4-6",
      }),
      "/ws",
    );
    expect(
      (providers(config).openrouter as { models: Array<{ id: string }> }).models.map(
        (m) => m.id,
      ),
    ).toEqual(["qwen/qwen3.7-plus", "anthropic/claude-sonnet-4-6"]);
  });

  it("OpenRouter with cost tracking OFF → no proxy, no models overlay", () => {
    const config = buildOpenclawConfig(
      makeEnv({
        LLM_PROVIDER: "openrouter",
        LLM_MODEL: "qwen/qwen3.7-plus",
        LLM_API_KEY: "sk-or-test",
        OPENROUTER_COST_TRACKING: false,
      }),
      "/ws",
    );
    // Kill switch off → openclaw talks straight to the built-in OpenRouter
    // provider (no baseUrl) and no compat overlay is emitted.
    expect(providers(config)).toEqual({ openrouter: { apiKey: "sk-or-test" } });
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

describe("buildOpenclawConfig heartbeat (autonomous idle-inference cost)", () => {
  const heartbeat = (config: Record<string, unknown>) =>
    (config.agents as { defaults: { heartbeat?: { every?: string } } }).defaults.heartbeat;

  it("disables the heartbeat by default (unset → every:'0' → openclaw skips scheduling)", () => {
    expect(heartbeat(buildOpenclawConfig(makeEnv({}), "/ws"))).toEqual({ every: "0" });
  });

  it.each(["off", "none", "0", "disabled", "false", "no", "", "  OFF  "])(
    "treats %j as an off switch → every:'0'",
    (value) => {
      const config = buildOpenclawConfig(makeEnv({ OPENCLAW_HEARTBEAT_EVERY: value }), "/ws");
      expect(heartbeat(config)).toEqual({ every: "0" });
    },
  );

  it("passes an explicit duration through to re-enable the tick per-agent", () => {
    const config = buildOpenclawConfig(makeEnv({ OPENCLAW_HEARTBEAT_EVERY: "8h" }), "/ws");
    expect(heartbeat(config)).toEqual({ every: "8h" });
  });

  it("trims surrounding whitespace on an explicit duration", () => {
    expect(resolveHeartbeatEvery(makeEnv({ OPENCLAW_HEARTBEAT_EVERY: "  30m " }))).toBe("30m");
  });

  it("resolveHeartbeatEvery maps unset/off to '0'", () => {
    expect(resolveHeartbeatEvery(makeEnv({}))).toBe("0");
    expect(resolveHeartbeatEvery(makeEnv({ OPENCLAW_HEARTBEAT_EVERY: "Off" }))).toBe("0");
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

  /**
   * Every plugin directory this module wires into openclaw.json MUST ship an
   * `openclaw.plugin.json` manifest and a `package.json`, or openclaw refuses to
   * start AT ALL:
   *
   *   Gateway failed to start: Invalid config at .../openclaw.json.
   *   plugins: plugin: plugin manifest not found: .../<dir>/openclaw.plugin.json
   *
   * That is a boot crash-loop on every agent running the image, not a degraded
   * feature — a plugin added with only its code is a fleet-wide outage. This
   * test walks the real directories on disk so a new plugin cannot be wired
   * without its manifest.
   */
  it("every wired plugin directory ships a manifest and a package.json", async () => {
    const config = buildOpenclawConfig(
      makeEnv({
        PLATFORM_MCP_URL: "https://console.example/api/mcp",
        PLATFORM_API_TOKEN: "knox_agent_x",
      }),
      "/ws",
    );
    const paths = plugins(config).load?.paths ?? [];
    expect(paths.length).toBeGreaterThan(0);

    for (const dir of paths) {
      const manifestRaw = await readFile(join(dir, "openclaw.plugin.json"), "utf8");
      const manifest = JSON.parse(manifestRaw) as { id?: string };
      const pkgRaw = await readFile(join(dir, "package.json"), "utf8");
      const pkg = JSON.parse(pkgRaw) as { name?: string; type?: string; main?: string };

      // The manifest id is the key openclaw looks the plugin up by, so it must
      // match the `entries` key this module writes.
      expect(
        Object.keys(plugins(config).entries ?? {}),
        `${dir}: manifest id must match an enabled entry`,
      ).toContain(manifest.id);
      expect(pkg.type, `${dir}: plugins are ESM`).toBe("module");
      expect(pkg.main, `${dir}: entrypoint`).toBe("index.js");
    }
  });

  it("wires all three plugins (load paths + enabled entries) when PLATFORM_MCP_URL is set", () => {
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
    expect(p.entries?.[TASK_PROGRESS_PLUGIN_ID]).toEqual({ enabled: true });
    expect(
      (p.load?.paths ?? []).some((path) => path.endsWith("openclaw-plugins/task-progress")),
    ).toBe(true);
  });

  it("does NOT wire the platform plugins when there is no PLATFORM_MCP_URL (no platform MCP reachable)", () => {
    const config = buildOpenclawConfig(makeEnv({}), "/ws");
    const p = plugins(config);
    // All three platform plugins are consumers of the platform MCP and are
    // pointless without it.
    expect(p.entries?.[DELEGATED_CREDS_PLUGIN_ID]).toBeUndefined();
    expect(p.entries?.[REPORT_OUTCOME_PLUGIN_ID]).toBeUndefined();
    expect(p.entries?.[TASK_PROGRESS_PLUGIN_ID]).toBeUndefined();
    for (const dir of ["delegated-credentials", "report-outcome", "task-progress"]) {
      expect(
        (p.load?.paths ?? []).some((path) => path.endsWith(`openclaw-plugins/${dir}`)),
        `${dir} must not be wired without a platform MCP`,
      ).toBe(false);
    }
  });

  it("ALWAYS wires usage telemetry, platform MCP or not (every vessel burns tokens)", () => {
    for (const env of [
      makeEnv({}),
      makeEnv({
        PLATFORM_MCP_URL: "https://console.example/api/mcp",
        PLATFORM_API_TOKEN: "knox_agent_x",
      }),
    ]) {
      const p = plugins(buildOpenclawConfig(env, "/ws"));
      // Must opt into conversation-hook access or openclaw blocks its `llm_output`
      // hook and the plugin reports nothing (no cache split, no model_calls, no
      // cost). See buildOpenclawConfig.
      expect(p.entries?.[USAGE_TELEMETRY_PLUGIN_ID]).toEqual({
        enabled: true,
        hooks: { allowConversationAccess: true },
      });
      expect(
        (p.load?.paths ?? []).some((path) => path.endsWith("openclaw-plugins/usage-telemetry")),
      ).toBe(true);
    }
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

  it("emits no allow/alsoAllow/toolSearch keys by default", () => {
    const t = tools(buildOpenclawConfig(makeEnv({}), "/ws"));
    expect(t.allow).toBeUndefined();
    expect(t.alsoAllow).toBeUndefined();
    expect(t.toolSearch).toBeUndefined();
  });

  it("wires tools.allow (parsed) as a complete allowlist", () => {
    const t = tools(
      buildOpenclawConfig(
        makeEnv({
          OPENCLAW_TOOLS_ALLOW: "group:openclaw knoxville_platform__* odoo_production__sales_confirm_order",
        }),
        "/ws",
      ),
    );
    expect(t.allow).toEqual([
      "group:openclaw",
      "knoxville_platform__*",
      "odoo_production__sales_confirm_order",
    ]);
    expect(t.alsoAllow).toBeUndefined();
  });

  it("wires tools.alsoAllow (parsed) as profile additions", () => {
    const t = tools(
      buildOpenclawConfig(
        makeEnv({
          OPENCLAW_TOOLS_PROFILE: "coding",
          OPENCLAW_TOOLS_ALSO_ALLOW: "odoo_production__ap_create_vendor_bill",
        }),
        "/ws",
      ),
    );
    expect(t.profile).toBe("coding");
    expect(t.alsoAllow).toEqual(["odoo_production__ap_create_vendor_bill"]);
    expect(t.allow).toBeUndefined();
  });

  it("never emits allow + alsoAllow together (openclaw rejects the pair; allow wins)", () => {
    // Defense in depth: loadEnv fails fast on this combo, but a config built
    // from a hand-made env must still never emit the invalid pair.
    const t = tools(
      buildOpenclawConfig(
        makeEnv({
          OPENCLAW_TOOLS_ALLOW: "group:openclaw",
          OPENCLAW_TOOLS_ALSO_ALLOW: "odoo_production__x",
        }),
        "/ws",
      ),
    );
    expect(t.allow).toEqual(["group:openclaw"]);
    expect(t.alsoAllow).toBeUndefined();
  });

  it("wires root tools.toolSearch when OPENCLAW_TOOL_SEARCH=tools", () => {
    const t = tools(buildOpenclawConfig(makeEnv({ OPENCLAW_TOOL_SEARCH: "tools" }), "/ws"));
    expect(t.toolSearch).toEqual({ enabled: true, mode: "tools" });
  });

  it("passes through code mode verbatim (openclaw resolves the --permission fallback)", () => {
    const t = tools(buildOpenclawConfig(makeEnv({ OPENCLAW_TOOL_SEARCH: "code" }), "/ws"));
    expect(t.toolSearch).toEqual({ enabled: true, mode: "code" });
  });

  // Regression: toolSearch must MERGE into the root tools block, not replace it.
  // An earlier draft emitted a second `tools` key that clobbered exec/allow/deny
  // whenever toolSearch was on.
  it("keeps exec + allow + deny intact when toolSearch is also on", () => {
    const t = tools(
      buildOpenclawConfig(
        makeEnv({
          OPENCLAW_TOOL_SEARCH: "tools",
          OPENCLAW_TOOLS_ALLOW: "group:openclaw",
          OPENCLAW_TOOLS_DENY: "group:sessions",
        }),
        "/ws",
      ),
    );
    expect((t.exec as { pathPrepend?: string[] }).pathPrepend).toEqual([
      "/opt/knox-exec-shim",
      "/opt/skills-venv/bin",
    ]);
    expect(t.allow).toEqual(["group:openclaw"]);
    expect(t.deny).toEqual(["group:sessions"]);
    expect(t.toolSearch).toEqual({ enabled: true, mode: "tools" });
  });
});

describe("parseToolsDeny", () => {
  it("is the back-compat alias for parseToolList", () => {
    expect(parseToolsDeny).toBe(parseToolList);
  });

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

describe("buildOpenclawConfig bootstrap char caps", () => {
  const CONSTITUTION_CHARS = 20792; // prompts/constitution.md, the first SOUL section

  function caps(config: Record<string, unknown>) {
    return (
      config.agents as {
        defaults: { bootstrapMaxChars?: number; bootstrapTotalMaxChars?: number };
      }
    ).defaults;
  }

  it("sets a per-file cap above a real SOUL.md (constitution + sections)", () => {
    // The whole bug: the cap must exceed the constitution (20,792) plus the
    // identity/charter/capabilities/memory/playbook/footer that follow it, or
    // openclaw truncates the tail. Anything at or below the constitution size is
    // the regression.
    const d = caps(buildOpenclawConfig(makeEnv({}), "/ws"));
    expect(d.bootstrapMaxChars).toBeGreaterThan(CONSTITUTION_CHARS);
    // Guard the specific regression value too — 24000 left only ~3.2k of
    // headroom over the constitution, far short of a real SOUL.
    expect(d.bootstrapMaxChars).toBeGreaterThanOrEqual(48000);
  });

  it("raises the COMBINED cap above openclaw's 60000 default", () => {
    // SOUL (up to the per-file cap) + AGENTS + TOOLS can exceed 60000, which
    // would truncate at the aggregate level even with each file under its own cap.
    const d = caps(buildOpenclawConfig(makeEnv({}), "/ws"));
    expect(d.bootstrapTotalMaxChars).toBeGreaterThan(60000);
    // The total must leave room for AGENTS.md + TOOLS.md on top of a full SOUL.
    expect(d.bootstrapTotalMaxChars).toBeGreaterThan(d.bootstrapMaxChars ?? 0);
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
