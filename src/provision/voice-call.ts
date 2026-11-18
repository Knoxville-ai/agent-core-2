import { createRequire } from "node:module";
import { dirname } from "node:path";

import { z } from "zod";

import { log } from "../log.js";

/**
 * Phone calls for an agent: render the official `@openclaw/voice-call` plugin's
 * `plugins.entries.voice-call` block from the console-written OPENCLAW_VOICE_CALL
 * env var, so a phone number is a durable, per-agent capability instead of a
 * hand-patched openclaw.json (which buildOpenclawConfig overwrites every boot).
 *
 * Contract (console → vessel): OPENCLAW_VOICE_CALL is a JSON object matching
 * {@link VoiceCallSpecSchema}. It deliberately carries NO secrets. The plugin
 * reads them from the container env, where Railway variables / credential
 * bindings put them:
 *   - TELNYX_API_KEY, TELNYX_CONNECTION_ID, TELNYX_PUBLIC_KEY  (provider telnyx)
 *   - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN                     (provider twilio)
 *   - PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN                           (provider plivo)
 *   - OPENAI_API_KEY                         (realtime voice, provider openai)
 * (verified in @openclaw/voice-call 2026.5.20: resolveVoiceCallConfig falls back
 * to these env vars for any field left unset; the OpenAI realtime bridge falls
 * back to OPENAI_API_KEY.)
 *
 * Safety defaults: inbound is allowlist-only, and the agent may NOT place calls
 * (the `voice_call` tool is denied) unless the spec turns `outbound.enabled` on.
 * AI-voice outbound calling needs the callee's prior consent (TCPA), so that
 * switch belongs to an operator, never to a default.
 *
 * Everything here fails SOFT: a malformed spec, a missing secret or a missing
 * public URL logs an error and leaves the phone off. A phone misconfiguration
 * must never stop the agent from booting.
 */

/** Plugin id (the key under `plugins.entries`) — fixed by the plugin manifest. */
export const VOICE_CALL_PLUGIN_ID = "voice-call";

/** Port the plugin's webhook server listens on (the plugin's own default). The
 *  agent's voice domain on Railway must target this port; 8080 stays the shim.
 *  Neither the shim (8080), the gateway (18789) nor the cost proxy (18790) use
 *  it. Also EXPOSEd in the Dockerfile. */
export const VOICE_CALL_PORT = 3334;

/** Webhook path (the plugin's default). Appended to a base-only public URL. */
export const VOICE_CALL_WEBHOOK_PATH = "/voice/webhook";

/** The agent-side tool the plugin registers for placing / steering calls. Denied
 *  unless outbound is enabled. Inbound calls never go through it. */
export const VOICE_CALL_TOOL = "voice_call";

/**
 * Where the baked plugin package lives, or null when it isn't installed. It is
 * an npm dependency of this repo (package.json, pinned to the image's openclaw
 * version), so it resolves from /app/node_modules in the image and from the
 * checkout in tests. Resolved lazily so a missing package degrades to "no
 * phone" instead of failing module load.
 */
export function resolveVoiceCallPluginDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve("@openclaw/voice-call/package.json"));
  } catch {
    return null;
  }
}

const E164 = z.string().regex(/^\+[1-9]\d{1,14}$/, "expected E.164, e.g. +18655550123");

/**
 * The console → vessel wire shape of OPENCLAW_VOICE_CALL. Mirrored by the
 * console's Phone tab (src/lib/voice/spec.ts in knoxville-ai-console); keep the
 * two in sync. Unknown keys are rejected so a typo surfaces in the boot log
 * rather than silently doing nothing.
 */
export const VoiceCallSpecSchema = z
  .object({
    /** Master switch. The phone is on when the blob is present unless false. */
    enabled: z.boolean().optional(),
    provider: z.enum(["telnyx", "twilio", "plivo", "mock"]).optional(),
    /** The agent's own number. Required for every provider but mock. */
    fromNumber: E164.optional(),
    /** Telnyx Call Control connection (Voice API application) id. Not a
     *  secret; TELNYX_CONNECTION_ID is used when this is unset. */
    connectionId: z.string().min(1).optional(),
    /** Full public webhook URL, or just its origin (the webhook path is then
     *  appended). Falls back to VOICE_PUBLIC_URL. */
    publicUrl: z.string().optional(),
    /** Who may call in. Default allowlist (only `allowFrom`). */
    inboundPolicy: z.enum(["disabled", "allowlist", "open"]).optional(),
    allowFrom: z.array(E164).optional(),
    inboundGreeting: z.string().optional(),
    /** Operator guidance for how the agent should behave on calls. */
    callPrompt: z.string().optional(),
    /** per-phone (default): one voice session per caller, so a caller's
     *  context carries across calls. per-call: a fresh session every call. */
    sessionScope: z.enum(["per-phone", "per-call"]).optional(),
    maxDurationSeconds: z.number().int().positive().optional(),
    maxConcurrentCalls: z.number().int().positive().optional(),
    outbound: z
      .object({
        /** Let the agent place calls with the voice_call tool. Default false. */
        enabled: z.boolean().optional(),
        defaultMode: z.enum(["notify", "conversation"]).optional(),
      })
      .strict()
      .optional(),
    realtime: z
      .object({
        /** Speech-to-speech voice (default on). Off = the plugin's turn-based
         *  STT → agent → TTS loop. */
        enabled: z.boolean().optional(),
        /** Realtime voice provider id (default "openai"). */
        provider: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        voice: z.string().min(1).optional(),
        /** When the voice model hands off to the full agent. */
        consultPolicy: z.enum(["auto", "substantive", "always"]).optional(),
        /** What the full agent may use when consulted mid-call. Default: all of
         *  its tools ("owner") for allowlisted callers, read-only otherwise. */
        toolPolicy: z.enum(["safe-read-only", "owner", "none"]).optional(),
        /** Search the agent's memory and past sessions before handing off.
         *  CAUTION: when the search finds anything, the snippets ARE the answer
         *  and the full agent is not consulted for that question (no tools, no
         *  background tasks). Off by default. */
        fastContext: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type VoiceCallSpec = z.infer<typeof VoiceCallSpecSchema>;

/** Base instructions for the realtime voice model. The plugin's own default,
 *  reworded for a Knoxville agent; the operator's callPrompt is appended. */
export const REALTIME_BASE_INSTRUCTIONS =
  "You are this agent's voice on a phone call. Keep spoken replies brief, natural and easy to follow by ear — no lists, markdown or URLs. " +
  "When a question needs deeper reasoning, current information, the agent's memory or its tools, call openclaw_agent_consult before answering, and say a short filler line while you wait.\n\n" +
  "Don't keep the caller on hold for long work. If they ask for something that will take more than a few seconds — research, drafting, " +
  "several steps of tool work — call openclaw_agent_consult and ask the agent to START it as a background task (start_task with self: true) " +
  "rather than do it now. Then tell the caller it's underway, that they can hang up, and that the result will be posted to this call's " +
  "conversation in their Knoxville console.";

/** Env vars the plugin needs per provider (when the spec doesn't carry them). */
function requiredProviderEnv(spec: VoiceCallSpec, provider: string): string[] {
  switch (provider) {
    case "telnyx":
      return [
        "TELNYX_API_KEY",
        ...(spec.connectionId ? [] : ["TELNYX_CONNECTION_ID"]),
        "TELNYX_PUBLIC_KEY",
      ];
    case "twilio":
      return ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"];
    case "plivo":
      return ["PLIVO_AUTH_ID", "PLIVO_AUTH_TOKEN"];
    default:
      return [];
  }
}

/** Normalize a public URL: https only, base-only URLs get the webhook path.
 *  Returns null for anything unusable. Exported for unit tests. */
export function normalizeVoicePublicUrl(raw: string | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.pathname === "" || url.pathname === "/") url.pathname = VOICE_CALL_WEBHOOK_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export interface VoiceCallRender {
  /** The `plugins.entries["voice-call"]` value. */
  entry: { enabled: true; config: Record<string, unknown> };
  /** Absolute plugin directory to add to `plugins.load.paths`. */
  pluginDir: string;
  /** Tools to add to `tools.deny` (the outbound kill switch). */
  toolsDeny: string[];
}

/**
 * Resolve OPENCLAW_VOICE_CALL (+ VOICE_PUBLIC_URL and the provider secrets in
 * `envSource`) into the plugin entry, or `{ render: null, reason }` when the
 * phone stays off. `reason` is null when no phone was configured at all, and a
 * human-readable problem list otherwise. Pure apart from plugin-dir lookup
 * (injectable for tests). Never throws.
 */
export function resolveVoiceCall(
  raw: string | undefined,
  opts: {
    publicUrl?: string;
    envSource?: Record<string, string | undefined>;
    pluginDir?: string | null;
  } = {},
): { render: VoiceCallRender | null; reason: string | null } {
  if (!raw || !raw.trim()) return { render: null, reason: null };
  const envSource = opts.envSource ?? process.env;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { render: null, reason: `OPENCLAW_VOICE_CALL is not valid JSON: ${(e as Error).message}` };
  }
  const parsed = VoiceCallSpecSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    return { render: null, reason: `OPENCLAW_VOICE_CALL is invalid: ${issues}` };
  }
  const spec = parsed.data;
  if (spec.enabled === false) return { render: null, reason: null };

  const problems: string[] = [];
  const provider = spec.provider ?? "telnyx";
  if (provider !== "mock" && !spec.fromNumber) problems.push("fromNumber is required");

  const missingEnv = requiredProviderEnv(spec, provider).filter((k) => !envSource[k]?.trim());
  if (missingEnv.length) problems.push(`missing env ${missingEnv.join(", ")}`);

  const inboundPolicy = spec.inboundPolicy ?? "allowlist";
  const allowFrom = [...new Set(spec.allowFrom ?? [])];
  const realtimeOn = spec.realtime?.enabled ?? true;
  const realtimeProvider = spec.realtime?.provider ?? "openai";
  if (realtimeOn) {
    if (provider !== "telnyx" && provider !== "twilio") {
      problems.push(`realtime voice needs provider telnyx or twilio (got ${provider})`);
    }
    if (inboundPolicy === "disabled") {
      problems.push("realtime voice needs inbound calls (inboundPolicy is disabled)");
    }
    if (realtimeProvider === "openai" && !envSource.OPENAI_API_KEY?.trim()) {
      problems.push("missing env OPENAI_API_KEY (realtime provider openai)");
    }
  }

  // The provider must be able to reach us; the plugin refuses a local URL for
  // every real provider, and Telnyx/Twilio stream realtime audio back to it.
  const publicUrl = normalizeVoicePublicUrl(spec.publicUrl ?? opts.publicUrl);
  if (provider !== "mock" && !publicUrl) {
    problems.push(
      "no public webhook URL: set VOICE_PUBLIC_URL to the https domain that targets port " +
        `${VOICE_CALL_PORT} (or publicUrl in the spec)`,
    );
  }

  const pluginDir = opts.pluginDir === undefined ? resolveVoiceCallPluginDir() : opts.pluginDir;
  if (!pluginDir) problems.push("@openclaw/voice-call is not installed in this image");

  if (problems.length || !pluginDir) {
    return { render: null, reason: `phone disabled: ${problems.join("; ")}` };
  }

  // Full agent tools mid-call only when every caller is a known number.
  const toolPolicy =
    spec.realtime?.toolPolicy ?? (inboundPolicy === "allowlist" ? "owner" : "safe-read-only");
  const callPrompt = spec.callPrompt?.trim();
  const outboundOn = spec.outbound?.enabled === true;

  // Only keys from the plugin's 2026.5.20 configSchema (additionalProperties:
  // false at every level — an unknown key fails `openclaw config validate`).
  // Unset optional keys are omitted so the plugin's own defaults apply.
  const config: Record<string, unknown> = {
    enabled: true,
    provider,
    ...(spec.fromNumber ? { fromNumber: spec.fromNumber } : {}),
    ...(provider === "telnyx" && spec.connectionId
      ? { telnyx: { connectionId: spec.connectionId } }
      : {}),
    inboundPolicy,
    ...(allowFrom.length ? { allowFrom } : {}),
    ...(spec.inboundGreeting?.trim() ? { inboundGreeting: spec.inboundGreeting.trim() } : {}),
    ...(callPrompt ? { responseSystemPrompt: callPrompt } : {}),
    sessionScope: spec.sessionScope ?? "per-phone",
    ...(spec.maxDurationSeconds ? { maxDurationSeconds: spec.maxDurationSeconds } : {}),
    ...(spec.maxConcurrentCalls ? { maxConcurrentCalls: spec.maxConcurrentCalls } : {}),
    ...(outboundOn && spec.outbound?.defaultMode
      ? { outbound: { defaultMode: spec.outbound.defaultMode } }
      : {}),
    // Bind on all interfaces: the plugin defaults to 127.0.0.1, which Railway's
    // edge can't reach, so the voice domain would 502.
    serve: { port: VOICE_CALL_PORT, bind: "0.0.0.0", path: VOICE_CALL_WEBHOOK_PATH },
    ...(publicUrl ? { publicUrl } : {}),
  };

  if (realtimeOn) {
    const providerCfg: Record<string, unknown> = {
      ...(spec.realtime?.model ? { model: spec.realtime.model } : {}),
      ...(spec.realtime?.voice ? { voice: spec.realtime.voice } : {}),
    };
    config.realtime = {
      enabled: true,
      provider: realtimeProvider,
      instructions: callPrompt
        ? `${REALTIME_BASE_INSTRUCTIONS}\n\nOperator instructions for calls:\n${callPrompt}`
        : REALTIME_BASE_INSTRUCTIONS,
      toolPolicy,
      consultPolicy: spec.realtime?.consultPolicy ?? "substantive",
      // Give the fast voice model the agent's identity (AGENTS.md is the
      // identity layer). Not SOUL.md: it opens with the ~20k constitution and
      // would fill the capsule before any identity made it in.
      ...(spec.realtime?.fastContext
        ? {
            fastContext: {
              enabled: true,
              timeoutMs: 800,
              maxResults: 3,
              sources: ["memory", "sessions"],
              fallbackToConsult: true,
            },
          }
        : {}),
      agentContext: {
        enabled: true,
        maxChars: 6000,
        includeIdentity: true,
        includeSystemPrompt: true,
        includeWorkspaceFiles: true,
        files: ["AGENTS.md"],
      },
      ...(Object.keys(providerCfg).length
        ? { providers: { [realtimeProvider]: providerCfg } }
        : {}),
    };
  }

  return {
    render: {
      entry: { enabled: true, config },
      pluginDir,
      toolsDeny: outboundOn ? [] : [VOICE_CALL_TOOL],
    },
    reason: null,
  };
}

/** Log the outcome once per config build (boot logs only; no secrets). */
export function logVoiceCall(result: { render: VoiceCallRender | null; reason: string | null }): void {
  if (result.render) {
    const c = result.render.entry.config;
    log.info("voice-call enabled", {
      provider: c.provider,
      fromNumber: c.fromNumber,
      inboundPolicy: c.inboundPolicy,
      allowFrom: Array.isArray(c.allowFrom) ? c.allowFrom.length : 0,
      realtime: Boolean((c.realtime as { enabled?: boolean } | undefined)?.enabled),
      outbound: result.render.toolsDeny.length === 0,
      publicUrl: c.publicUrl,
      port: VOICE_CALL_PORT,
    });
  } else if (result.reason) {
    log.error("voice-call not enabled", { reason: result.reason });
  }
}
