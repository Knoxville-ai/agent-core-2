import { describe, expect, it } from "vitest";

import { loadEnv } from "./env.js";

/**
 * Minimum env a vessel needs to boot. Everything the prompt-cache work added is
 * optional, so these tests pin the DEFAULTS — the values that ship when an
 * operator sets nothing.
 */
const REQUIRED = {
  AGENT_UID: "560bd7e31e229d1d",
  AGENT_ORG: "bacon-company",
  AGENT_ROLE: "generic",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  SUPABASE_JWT_SECRET: "jwt-secret",
  OPENCLAW_GATEWAY_TOKEN: "gateway-token-at-least-16-chars",
  LLM_PROVIDER: "openrouter",
  LLM_MODEL: "qwen/qwen3.7-plus",
  LLM_API_KEY: "sk-test",
};

function withEnv<T>(over: Record<string, string>, fn: () => T): T {
  const saved = process.env;
  process.env = { ...REQUIRED, ...over } as NodeJS.ProcessEnv;
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

describe("prompt-cache env defaults", () => {
  it("places the dynamic context block at the TAIL by default", () => {
    // This default is the whole point of the prefix-stability work: at "lead"
    // the per-turn block sits at index 0 and invalidates the entire cached
    // prompt prefix whenever a memory or caller-context row changes. Flipping
    // this default back silently reintroduces that, so pin it.
    const env = withEnv({}, loadEnv);
    expect(env.AGENT_DYNAMIC_CONTEXT_POSITION).toBe("tail");
  });

  it("still honours an explicit lead override (the rollback lever)", () => {
    const env = withEnv({ AGENT_DYNAMIC_CONTEXT_POSITION: "lead" }, loadEnv);
    expect(env.AGENT_DYNAMIC_CONTEXT_POSITION).toBe("lead");
  });

  it("rejects a position that is neither lead nor tail", () => {
    expect(() => withEnv({ AGENT_DYNAMIC_CONTEXT_POSITION: "middle" }, loadEnv)).toThrow(
      /AGENT_DYNAMIC_CONTEXT_POSITION/,
    );
  });

  it("leaves cache retention unset so nothing changes until an operator opts in", () => {
    const env = withEnv({}, loadEnv);
    expect(env.LLM_CACHE_RETENTION).toBeUndefined();
  });

  it.each(["short", "long", "none"])("accepts cache retention %s", (value) => {
    const env = withEnv({ LLM_CACHE_RETENTION: value }, loadEnv);
    expect(env.LLM_CACHE_RETENTION).toBe(value);
  });

  it("rejects an unknown cache retention rather than silently ignoring it", () => {
    expect(() => withEnv({ LLM_CACHE_RETENTION: "forever" }, loadEnv)).toThrow(
      /LLM_CACHE_RETENTION/,
    );
  });
});

describe("tool-block env levers (step 4)", () => {
  it("defaults tool search OFF (all-or-nothing deferral must be opt-in)", () => {
    // If this default ever flips to "tools"/"code", every agent silently starts
    // hiding its tools behind a search dance — a behavioral change, not a config
    // tweak. Pin it off.
    const env = withEnv({}, loadEnv);
    expect(env.OPENCLAW_TOOL_SEARCH).toBe("off");
  });

  it.each(["off", "tools", "code"])("accepts tool search mode %s", (mode) => {
    expect(withEnv({ OPENCLAW_TOOL_SEARCH: mode }, loadEnv).OPENCLAW_TOOL_SEARCH).toBe(mode);
  });

  it("rejects an unknown tool search mode", () => {
    expect(() => withEnv({ OPENCLAW_TOOL_SEARCH: "semantic" }, loadEnv)).toThrow(
      /OPENCLAW_TOOL_SEARCH/,
    );
  });

  it("leaves allow / alsoAllow unset by default (empty allowlist = fail-open)", () => {
    const env = withEnv({}, loadEnv);
    expect(env.OPENCLAW_TOOLS_ALLOW).toBeUndefined();
    expect(env.OPENCLAW_TOOLS_ALSO_ALLOW).toBeUndefined();
  });

  it("rejects allow + alsoAllow together (openclaw forbids the pair)", () => {
    // Verified against openclaw's own `config validate`: a scope with both keys
    // is invalid and the agent would crash-loop at boot. Fail fast instead.
    expect(() =>
      withEnv(
        { OPENCLAW_TOOLS_ALLOW: "group:openclaw", OPENCLAW_TOOLS_ALSO_ALLOW: "odoo_production__x" },
        loadEnv,
      ),
    ).toThrow(/OPENCLAW_TOOLS_ALSO_ALLOW/);
  });

  it("allows profile + alsoAllow (the valid additive shape)", () => {
    const env = withEnv(
      { OPENCLAW_TOOLS_PROFILE: "coding", OPENCLAW_TOOLS_ALSO_ALLOW: "odoo_production__x" },
      loadEnv,
    );
    expect(env.OPENCLAW_TOOLS_ALSO_ALLOW).toBe("odoo_production__x");
  });
});
