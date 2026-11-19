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
    /** People the agent knows by number (the console's "Accept calls from"
     *  member picker). Their numbers join `allowFrom`; the voice and the agent
     *  are told who is calling, and the call is filed under `userId`. */
    callers: z
      .array(
        z
          .object({
            phone: E164,
            name: z.string().min(1).max(120),
            userId: z.string().min(1).optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    /** Text the result of phone-started work to the caller once the call is
     *  over (src/voice/notify.ts). Needs the number on a Telnyx messaging
     *  profile and, for US recipients, 10DLC registration. Off by default. */
    sms: z
      .object({
        enabled: z.boolean().optional(),
        messagingProfileId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
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
  "conversation in their Knoxville console.\n\n" +
  "A consult can take 20-30 seconds. While it runs you get a result with status \"working\": that is NOT a failure. Tell the caller " +
  "you're on it and wait for the final result; don't call openclaw_agent_consult again for the same request meanwhile, and if the " +
  "caller asks you to just handle it, say you're getting it started and ask them to hold a few more seconds until it's confirmed.\n\n" +
  "When you're told that work started on this call is waiting on the caller's decision or approval, ask them right " +
  "away: what's waiting and the choices, briefly. For an approval, ask them to say their phone PIN too. Then call " +
  "openclaw_agent_consult with their exact answer (and PIN) so the agent records it — never decide for them, and " +
  "don't send them to the console.\n\n" +
  "Never tell the caller that something was started, sent, booked, delegated or saved unless the FINAL answer from " +
  "openclaw_agent_consult says it was. If that final answer is an error or comes back empty, say plainly that you couldn't get it " +
  "done and offer to try again.";

export type KnownCaller = NonNullable<VoiceCallSpec["callers"]>[number];

/** "+19016512542" → "+1 901-651-2542" for spoken/prompt use. */
export function displayPhone(e164: string): string {
  const d = e164.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return `+1 ${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
  return e164;
}

/** The voice model's instructions: base + who may be calling + the operator's
 *  call prompt. Exported for unit tests. */
export function buildRealtimeInstructions(
  callers: readonly KnownCaller[],
  inboundPolicy: string,
  callPrompt: string | undefined,
): string {
  const parts = [REALTIME_BASE_INSTRUCTIONS];
  if (callers.length > 0) {
    const list = callers.map((c) => `${c.name} (${displayPhone(c.phone)})`).join("; ");
    if (inboundPolicy === "allowlist" && callers.length === 1) {
      parts.push(
        `Only ${callers[0]!.name} can reach this line, so every caller is ${callers[0]!.name} (${displayPhone(callers[0]!.phone)}). ` +
          "Greet them by name and treat their requests as theirs.",
      );
    } else if (inboundPolicy === "allowlist") {
      parts.push(`Only these people can reach this line: ${list}. If you're not sure which of them is calling, ask.`);
    } else {
      parts.push(`People you know by phone: ${list}. Anyone else is an unknown caller.`);
    }
  }
  if (callPrompt) parts.push(`Operator instructions for calls:\n${callPrompt}`);
  return parts.join("\n\n");
}

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
  /** Known callers, for the call mirror and the voice-context plugin. */
  callers: KnownCaller[];
  /** Texting results after a call (null = off), and who may be texted. */
  sms: { from: string; messagingProfileId?: string } | null;
  textable: string[];
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
    /** `<provider>/<model>` the agent runs on. The plugin otherwise answers
     *  mid-call handoffs with OpenClaw's built-in default model (seen live:
     *  openai/gpt-5.5), not the agent's — wrong model, wrong bill. */
    responseModel?: string;
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
  const callers = spec.callers ?? [];
  const allowFrom = [...new Set([...(spec.allowFrom ?? []), ...callers.map((c) => c.phone)])];
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
    ...(opts.responseModel ? { responseModel: opts.responseModel } : {}),
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
      instructions: buildRealtimeInstructions(callers, inboundPolicy, callPrompt),
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
      callers,
      sms:
        spec.sms?.enabled && spec.fromNumber && provider === "telnyx"
          ? { from: spec.fromNumber, ...(spec.sms.messagingProfileId ? { messagingProfileId: spec.sms.messagingProfileId } : {}) }
          : null,
      textable: allowFrom,
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
