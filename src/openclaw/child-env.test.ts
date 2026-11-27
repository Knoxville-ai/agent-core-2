import { describe, expect, it } from "vitest";

import { AGENT_ENV_KEYS } from "../env.js";
import {
  CHILD_PLATFORM_ALLOW,
  childEnv,
  isWithheldFromChildren,
  withheldNames,
} from "./child-env.js";

/** A container environment as the console + Railway + the image write it. */
const CONTAINER_ENV: NodeJS.ProcessEnv = {
  // image
  PATH: "/home/agent/.npm-global/bin:/opt/skills-venv/bin:/usr/bin:/bin",
  HOME: "/home/agent",
  NODE_ENV: "production",
  NPM_CONFIG_PREFIX: "/home/agent/.npm-global",
  PLAYWRIGHT_BROWSERS_PATH: "/opt/pw-browsers",
  U2NET_HOME: "/home/agent/.openclaw/u2net",
  // platform
  AGENT_UID: "560bd7e31e229d1d",
  AGENT_ORG: "org-1",
  AGENT_ROLE: "generic",
  AGENT_HTTP_PORT: "8080",
  OPENCLAW_GATEWAY_PORT: "18789",
  OPENCLAW_STATE_DIR: "/home/agent/.openclaw",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "platform-db-key",
  SUPABASE_JWT_SECRET: "platform-jwt-secret",
  AGENT_SUPABASE_SECRET_KEY: "platform-db-key-2",
  PLATFORM_API_TOKEN: "knox_agent_abc",
  PLATFORM_MCP_URL: "https://console.example/api/mcp",
  PLATFORM_JWKS_URL: "https://console.example/api/agent-auth/jwks",
  OPENCLAW_GATEWAY_TOKEN: "console-gateway-token",
  MESSAGING_ENABLED: "true",
  LLM_PROVIDER: "openrouter",
  LLM_MODEL: "qwen/qwen3.7-plus",
  LLM_API_KEY: "sk-model",
  LLM_API_KEY_CREDENTIAL_ID: "cred-1",
  OPENCLAW_MCP_SERVERS: '{"x":{"url":"https://x","headers":{"Authorization":"Bearer inline"}}}',
  OPENCLAW_AUTH_PROFILE_SECRET_KEY: "oauth-seed",
  RAILWAY_PROJECT_ID: "proj",
  RAILWAY_PRIVATE_DOMAIN: "svc.railway.internal",
  // customer: credential-bound aliases + Environment tab + phone tab
  SPORTSINC_API_KEY: "vendor-key",
  KNOX_GITHUB_TOKEN: "ghp_customer",
  TELNYX_API_KEY: "telnyx-key",
  OPENAI_API_KEY: "sk-realtime",
  SUPABASE_ANON_KEY: "customer-own-project-anon",
  GOOGLE_CSE_ID: "cse-id",
  GOOGLE_CSE_API_KEY: "cse-key",
  MY_SETTING: "value",
};

describe("childEnv", () => {
  it("withholds the platform database and signing secrets", () => {
    const env = childEnv({}, CONTAINER_ENV);
    for (const name of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_JWT_SECRET",
      "AGENT_SUPABASE_SECRET_KEY",
      "SUPABASE_URL",
    ]) {
      expect(env[name], name).toBeUndefined();
    }
  });

  it("withholds the agent's platform token and the rest of the vessel config", () => {
    const env = childEnv({}, CONTAINER_ENV);
    for (const name of [
      "PLATFORM_API_TOKEN",
      "OPENCLAW_GATEWAY_TOKEN",
      "PLATFORM_MCP_URL",
      "PLATFORM_JWKS_URL",
      "MESSAGING_ENABLED",
      "LLM_PROVIDER",
      "LLM_MODEL",
      "LLM_API_KEY",
      "LLM_API_KEY_CREDENTIAL_ID",
      "OPENCLAW_MCP_SERVERS",
      "RAILWAY_PROJECT_ID",
      "RAILWAY_PRIVATE_DOMAIN",
    ]) {
      expect(env[name], name).toBeUndefined();
    }
  });

  it("keeps customer variables, credential aliases and image variables unchanged", () => {
    const env = childEnv({}, CONTAINER_ENV);
    for (const name of [
      "SPORTSINC_API_KEY",
      "KNOX_GITHUB_TOKEN",
      "TELNYX_API_KEY",
      "OPENAI_API_KEY",
      "SUPABASE_ANON_KEY",
      "GOOGLE_CSE_ID",
      "GOOGLE_CSE_API_KEY",
      "MY_SETTING",
      "PATH",
      "HOME",
      "NODE_ENV",
      "NPM_CONFIG_PREFIX",
      "PLAYWRIGHT_BROWSERS_PATH",
      "U2NET_HOME",
    ]) {
      expect(env[name], name).toBe(CONTAINER_ENV[name]);
    }
  });

  it("keeps the allowlisted platform variables", () => {
    const env = childEnv({}, CONTAINER_ENV);
    for (const name of CHILD_PLATFORM_ALLOW) {
      if (CONTAINER_ENV[name] !== undefined) expect(env[name], name).toBe(CONTAINER_ENV[name]);
    }
  });

  it("keeps the console's gateway token out of every child (the gateway included)", () => {
    expect(isWithheldFromChildren("OPENCLAW_GATEWAY_TOKEN")).toBe(true);
    expect(childEnv({}, CONTAINER_ENV).OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
  });

  it("withholds any variable shaped like a database service secret, whatever its prefix", () => {
    expect(isWithheldFromChildren("MY_SUPABASE_SERVICE_ROLE_KEY")).toBe(true);
    expect(isWithheldFromChildren("OTHER_JWT_SECRET")).toBe(true);
    expect(isWithheldFromChildren("platform_anything")).toBe(true);
  });

  it("withholds every variable env.ts declares unless the allowlist names it", () => {
    for (const name of AGENT_ENV_KEYS) {
      expect(isWithheldFromChildren(name), name).toBe(!CHILD_PLATFORM_ALLOW.has(name));
    }
  });

  it("applies overrides last and drops undefined ones", () => {
    const env = childEnv({ HOME: "/home", TMPDIR: "/t", MY_SETTING: undefined }, CONTAINER_ENV);
    expect(env.HOME).toBe("/home");
    expect(env.TMPDIR).toBe("/t");
    expect(env.MY_SETTING).toBeUndefined();
  });

  it("does not modify its source", () => {
    const source = { ...CONTAINER_ENV };
    childEnv({ HOME: "/x" }, source);
    expect(source).toEqual(CONTAINER_ENV);
  });

  it("lists withheld names (never values)", () => {
    const names = withheldNames(CONTAINER_ENV);
    expect(names).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(names).toContain("PLATFORM_API_TOKEN");
    expect(names).not.toContain("SPORTSINC_API_KEY");
    expect(names.join(",")).not.toContain("platform-db-key");
  });
});
