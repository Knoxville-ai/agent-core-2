import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentEnv } from "../env.js";
import { buildOpenclawConfig, explainUnwritableConfig } from "./render-workspace.js";
import {
  normalizeVoicePublicUrl,
  resolveVoiceCall,
  resolveVoiceCallPluginDir,
  VOICE_CALL_PLUGIN_ID,
  VOICE_CALL_PORT,
  VOICE_CALL_TOOL,
} from "./voice-call.js";

const TELNYX_ENV = {
  TELNYX_API_KEY: "KEYsecret-telnyx-api",
  TELNYX_CONNECTION_ID: "secret-conn-1",
  TELNYX_PUBLIC_KEY: "secret-telnyx-pubkey",
  OPENAI_API_KEY: "sk-secret-openai",
};
const PUBLIC = "https://frank-production-c5438a3c.up.railway.app";
const SPEC = {
  provider: "telnyx",
  fromNumber: "+18653501221",
  allowFrom: ["+18655550100"],
};

function resolve(spec: unknown, env: Record<string, string | undefined> = TELNYX_ENV) {
  return resolveVoiceCall(JSON.stringify(spec), {
    publicUrl: PUBLIC,
    envSource: env,
    pluginDir: "/app/node_modules/@openclaw/voice-call",
  });
}

describe("resolveVoiceCall", () => {
  it("unset / empty → no phone, no complaint", () => {
    expect(resolveVoiceCall(undefined)).toEqual({ render: null, reason: null });
    expect(resolveVoiceCall("  ")).toEqual({ render: null, reason: null });
  });

  it("enabled:false → off silently", () => {
    expect(resolve({ ...SPEC, enabled: false })).toEqual({ render: null, reason: null });
  });

  it("malformed JSON or unknown keys → off with a reason, never throws", () => {
    const bad = resolveVoiceCall("{nope", { envSource: TELNYX_ENV, pluginDir: "/x" });
    expect(bad.render).toBeNull();
    expect(bad.reason).toMatch(/not valid JSON/);
    const typo = resolve({ ...SPEC, fromNumbr: "+1" });
    expect(typo.render).toBeNull();
    expect(typo.reason).toMatch(/invalid/);
    const notE164 = resolve({ ...SPEC, fromNumber: "865-350-1221" });
    expect(notE164.reason).toMatch(/fromNumber/);
  });

  it("renders the safe default: telnyx, allowlist inbound, realtime openai, outbound tool denied", () => {
    const { render, reason } = resolve(SPEC);
    expect(reason).toBeNull();
    expect(render!.pluginDir).toBe("/app/node_modules/@openclaw/voice-call");
    expect(render!.toolsDeny).toEqual([VOICE_CALL_TOOL]);
    const c = render!.entry.config;
    expect(render!.entry.enabled).toBe(true);
    expect(c).toMatchObject({
      enabled: true,
      provider: "telnyx",
      fromNumber: "+18653501221",
      inboundPolicy: "allowlist",
      allowFrom: ["+18655550100"],
      sessionScope: "per-phone",
      serve: { port: VOICE_CALL_PORT, bind: "0.0.0.0", path: "/voice/webhook" },
      publicUrl: `${PUBLIC}/voice/webhook`,
    });
    expect(c.realtime).toMatchObject({
      enabled: true,
      provider: "openai",
      toolPolicy: "owner",
      consultPolicy: "substantive",
      agentContext: { enabled: true, files: ["AGENTS.md"] },
    });
    // No secrets in the rendered config — the plugin reads them from env.
    const json = JSON.stringify(c);
    for (const v of Object.values(TELNYX_ENV)) expect(json).not.toContain(v);
    expect(c).not.toHaveProperty("telnyx");
  });

  it("open inbound defaults the consult tools to read-only", () => {
    const { render } = resolve({ ...SPEC, inboundPolicy: "open", allowFrom: undefined });
    expect((render!.entry.config.realtime as { toolPolicy: string }).toolPolicy).toBe(
      "safe-read-only",
    );
    expect(render!.entry.config).not.toHaveProperty("allowFrom");
  });

  it("outbound.enabled lifts the tool deny and passes defaultMode", () => {
    const { render } = resolve({
      ...SPEC,
      outbound: { enabled: true, defaultMode: "conversation" },
    });
    expect(render!.toolsDeny).toEqual([]);
    expect(render!.entry.config.outbound).toEqual({ defaultMode: "conversation" });
  });

  it("callPrompt feeds both the realtime instructions and the turn-based prompt", () => {
    const { render } = resolve({ ...SPEC, callPrompt: "You answer for Drive Thru." });
    const c = render!.entry.config;
    expect(c.responseSystemPrompt).toBe("You answer for Drive Thru.");
    expect((c.realtime as { instructions: string }).instructions).toContain(
      "You answer for Drive Thru.",
    );
  });

  it("realtime voice/model go under realtime.providers.<provider>", () => {
    const { render } = resolve({ ...SPEC, realtime: { voice: "marin", model: "gpt-realtime-2" } });
    expect((render!.entry.config.realtime as { providers: unknown }).providers).toEqual({
      openai: { model: "gpt-realtime-2", voice: "marin" },
    });
  });

  it("fastContext is opt-in and falls back to the full agent on a miss", () => {
    const off = resolve(SPEC).render!.entry.config.realtime as Record<string, unknown>;
    expect(off).not.toHaveProperty("fastContext");
    const on = resolve({ ...SPEC, realtime: { fastContext: true } }).render!.entry.config
      .realtime as Record<string, unknown>;
    expect(on.fastContext).toEqual({
      enabled: true,
      timeoutMs: 800,
      maxResults: 3,
      sources: ["memory", "sessions"],
      fallbackToConsult: true,
    });
  });

  it("tells the voice model to hand long work off as a background task", () => {
    const rt = resolve(SPEC).render!.entry.config.realtime as { instructions: string };
    expect(rt.instructions).toContain("start_task with self: true");
  });

  it("known callers join the allowlist and the voice is told who is calling", () => {
    const { render } = resolve({
      ...SPEC,
      allowFrom: undefined,
      callers: [{ phone: "+19016512542", name: "Zach Tucker", userId: "u-1" }],
    });
    expect(render!.entry.config.allowFrom).toEqual(["+19016512542"]);
    expect(render!.callers).toEqual([{ phone: "+19016512542", name: "Zach Tucker", userId: "u-1" }]);
    const rt = render!.entry.config.realtime as { instructions: string };
    expect(rt.instructions).toContain("every caller is Zach Tucker (+1 901-651-2542)");
  });

  it("several callers: listed, and the voice asks when unsure", () => {
    const { render } = resolve({
      ...SPEC,
      callers: [
        { phone: "+19016512542", name: "Zach" },
        { phone: "+18655550199", name: "Ann" },
      ],
    });
    expect(render!.entry.config.allowFrom).toEqual(["+18655550100", "+19016512542", "+18655550199"]);
    const rt = render!.entry.config.realtime as { instructions: string };
    expect(rt.instructions).toContain("Only these people can reach this line: Zach (+1 901-651-2542); Ann");
  });

  it("never claims work it didn't confirm", () => {
    const rt = resolve(SPEC).render!.entry.config.realtime as { instructions: string };
    expect(rt.instructions).toContain("Never tell the caller that something was started");
    expect(rt.instructions).toContain('status \"working\": that is NOT a failure');
  });

  it("SMS is off unless enabled; texting is limited to the allowlist", () => {
    expect(resolve(SPEC).render!.sms).toBeNull();
    const r = resolve({ ...SPEC, sms: { enabled: true, messagingProfileId: "mp-1" } }).render!;
    expect(r.sms).toEqual({ from: "+18653501221", messagingProfileId: "mp-1" });
    expect(r.textable).toEqual(["+18655550100"]);
    // Not part of the plugin's own config (its schema would reject it).
    expect(r.entry.config).not.toHaveProperty("sms");
  });

  it("handoffs run on the agent's own model when given", () => {
    const r = resolveVoiceCall(JSON.stringify(SPEC), {
      publicUrl: PUBLIC,
      envSource: TELNYX_ENV,
      pluginDir: "/p",
      responseModel: "openrouter/z-ai/glm-5.2",
    });
    expect(r.render!.entry.config.responseModel).toBe("openrouter/z-ai/glm-5.2");
    expect(resolve(SPEC).render!.entry.config).not.toHaveProperty("responseModel");
  });

  it("realtime off → no realtime block and no OPENAI_API_KEY needed", () => {
    const env = { ...TELNYX_ENV, OPENAI_API_KEY: undefined };
    const { render, reason } = resolve({ ...SPEC, realtime: { enabled: false } }, env);
    expect(reason).toBeNull();
    expect(render!.entry.config).not.toHaveProperty("realtime");
  });

  it("connectionId in the spec replaces TELNYX_CONNECTION_ID", () => {
    const env = { ...TELNYX_ENV, TELNYX_CONNECTION_ID: undefined };
    const { render } = resolve({ ...SPEC, connectionId: "conn-spec" }, env);
    expect(render!.entry.config.telnyx).toEqual({ connectionId: "conn-spec" });
  });

  it("missing secrets / URL / plugin → off, every problem listed", () => {
    const r = resolveVoiceCall(JSON.stringify(SPEC), { envSource: {}, pluginDir: null });
    expect(r.render).toBeNull();
    expect(r.reason).toMatch(/TELNYX_API_KEY, TELNYX_CONNECTION_ID, TELNYX_PUBLIC_KEY/);
    expect(r.reason).toMatch(/OPENAI_API_KEY/);
    expect(r.reason).toMatch(/VOICE_PUBLIC_URL/);
    expect(r.reason).toMatch(/not installed/);
  });

  it("realtime with inbound disabled is refused (the plugin would reject it)", () => {
    const r = resolve({ ...SPEC, inboundPolicy: "disabled" });
    expect(r.render).toBeNull();
    expect(r.reason).toMatch(/inboundPolicy is disabled/);
  });

  it("the spec's publicUrl wins over VOICE_PUBLIC_URL", () => {
    const { render } = resolve({ ...SPEC, publicUrl: "https://voice.example.com/hook" });
    expect(render!.entry.config.publicUrl).toBe("https://voice.example.com/hook");
  });
});

describe("normalizeVoicePublicUrl", () => {
  it("appends the webhook path to a bare origin, keeps an explicit path", () => {
    expect(normalizeVoicePublicUrl("https://a.up.railway.app")).toBe(
      "https://a.up.railway.app/voice/webhook",
    );
    expect(normalizeVoicePublicUrl("a.up.railway.app/")).toBe(
      "https://a.up.railway.app/voice/webhook",
    );
    expect(normalizeVoicePublicUrl("https://a.example/x/y?z=1")).toBe("https://a.example/x/y");
  });
  it("rejects http and junk", () => {
    expect(normalizeVoicePublicUrl("http://a.example")).toBeNull();
    expect(normalizeVoicePublicUrl("::")).toBeNull();
    expect(normalizeVoicePublicUrl(undefined)).toBeNull();
  });
});

describe("resolveVoiceCallPluginDir", () => {
  it("finds the pinned package installed as a dependency", () => {
    expect(resolveVoiceCallPluginDir()).toMatch(/node_modules[\\/]@openclaw[\\/]voice-call$/);
  });
});

function makeEnv(overrides: Partial<AgentEnv>): AgentEnv {
  return {
    AGENT_UID: "0123456789abcdef",
    AGENT_ORG: "acme",
    AGENT_ROLE: "generic",
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
    AGENT_TOOL_CALL_TRACKING: true,
    AGENT_AUTO_TITLE: true,
    LOG_LEVEL: "info",
    ...overrides,
  } as AgentEnv;
}

describe("buildOpenclawConfig voice-call wiring", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("no OPENCLAW_VOICE_CALL → no voice-call entry, voice_call not denied", () => {
    const config = buildOpenclawConfig(makeEnv({}), "/ws");
    const plugins = config.plugins as { entries: Record<string, unknown> };
    expect(plugins.entries).not.toHaveProperty(VOICE_CALL_PLUGIN_ID);
    expect((config.tools as { deny: string[] }).deny).not.toContain(VOICE_CALL_TOOL);
  });

  it("renders the entry, loads the plugin dir and denies outbound — every build identical", () => {
    for (const [k, v] of Object.entries(TELNYX_ENV)) vi.stubEnv(k, v);
    const env = makeEnv({
      OPENCLAW_VOICE_CALL: JSON.stringify(SPEC),
      VOICE_PUBLIC_URL: PUBLIC,
      OPENCLAW_TOOLS_DENY: "group:sessions",
    });
    const config = buildOpenclawConfig(env, "/ws");
    const plugins = config.plugins as {
      load: { paths: string[] };
      entries: Record<string, { enabled: boolean; config: Record<string, unknown> }>;
    };
    expect(plugins.entries[VOICE_CALL_PLUGIN_ID]!.enabled).toBe(true);
    expect(plugins.entries[VOICE_CALL_PLUGIN_ID]!.config.fromNumber).toBe("+18653501221");
    expect(plugins.entries[VOICE_CALL_PLUGIN_ID]!.config.responseModel).toBe("anthropic/claude-opus-4-8");
    expect(plugins.entries["knox-voice-context"]).toEqual({ enabled: true });
    expect(plugins.load.paths.at(-2)).toBe(resolveVoiceCallPluginDir());
    expect(plugins.load.paths.at(-1)).toMatch(/openclaw-plugins[\\/]voice-context$/);
    // Existing plugins survive the merge.
    expect(Object.keys(plugins.entries).length).toBeGreaterThan(1);
    expect((config.tools as { deny: string[] }).deny).toEqual([
      "cron",
      "group:sessions",
      VOICE_CALL_TOOL,
    ]);
    // Redeploy-stable: same env in, same bytes out.
    expect(JSON.stringify(buildOpenclawConfig(env, "/ws"))).toBe(JSON.stringify(config));
  });

  it("a broken spec leaves the rest of the config intact", () => {
    const config = buildOpenclawConfig(makeEnv({ OPENCLAW_VOICE_CALL: "{" }), "/ws");
    expect((config.plugins as { entries: object }).entries).not.toHaveProperty(VOICE_CALL_PLUGIN_ID);
    expect(config.gateway).toBeDefined();
  });
});

describe("explainUnwritableConfig", () => {
  it("rewrites EACCES into an actionable message, passes other errors through", () => {
    const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const out = explainUnwritableConfig("/nonexistent/openclaw.json", eacces) as Error;
    expect(out.message).toMatch(/runuser -u agent -- openclaw/);
    expect(out.message).toMatch(/chown -R agent:agent \/nonexistent/);
    const other = new Error("ENOSPC");
    expect(explainUnwritableConfig("/x", other)).toBe(other);
  });
});
