import { z } from "zod";

const Schema = z.object({
  // Agent identity
  AGENT_UID: z.string().regex(/^[0-9a-f]{16}$/, "AGENT_UID must be 16-char lowercase hex"),
  AGENT_ORG: z.string().min(1),
  AGENT_ROLE: z.string().min(1).default("generic"),

  // Shim ↔ console auth
  SUPABASE_JWT_SECRET: z.string().min(1),
  MESSAGING_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),

  // Shim ↔ openclaw auth
  OPENCLAW_GATEWAY_TOKEN: z.string().min(16),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Model
  LLM_PROVIDER: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  LLM_API_KEY: z.string().optional().default(""),

  // Optional provider base URL override. When set it is written into
  // openclaw.json as models.providers.<LLM_PROVIDER>.baseUrl so the agent
  // can talk to ANY OpenAI-compatible endpoint instead of the provider's
  // hosted default. Two uses:
  //   - external cheap inference (Groq / DeepSeek / Together / OpenRouter /
  //     a self-hosted Ollama box) — set to that endpoint's /v1 URL.
  //   - in-container Ollama (LLM_PROVIDER=ollama) — left unset here and
  //     defaulted to the loopback Ollama server by buildOpenclawConfig.
  LLM_BASE_URL: z.string().url().optional(),

  // Explicit input-modality overrides, set by the console from the model
  // catalog (public.models.multimodal / file_input). Tri-state: unset =
  // undefined = fall back to the static (provider, model) table in
  // model-capabilities.ts; "true"/"1" = force-enable; anything else = force-
  // disable. Lets a runtime-added model the static table can't know about
  // (e.g. an OpenRouter vision model behind LLM_PROVIDER=openai) still get its
  // images/files forwarded. See resolveCapabilities.
  LLM_MULTIMODAL: z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v === "" ? undefined : v === "true" || v === "1",
    ),
  LLM_FILE_INPUT: z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v === "" ? undefined : v === "true" || v === "1",
    ),

  // Model auth mode. "api_key" (default) uses LLM_API_KEY. "oauth" wires
  // the OpenClaw OpenAI-Codex (ChatGPT) OAuth profile instead — the token
  // itself is NOT an env var; it lives in OpenClaw's encrypted auth-profile
  // store, minted on the running container (see routes-oauth) and persisted
  // to Supabase Storage so it survives redeploys.
  LLM_AUTH_MODE: z.enum(["api_key", "oauth"]).optional().default("api_key"),

  // Stable seed OpenClaw derives its auth-profile encryption key from
  // (sha256("openclaw:auth-profile-oauth:" + seed)). Set as a stable
  // per-agent secret so the encrypted OAuth store is portable: a store
  // persisted to Storage can be restored AND decrypted on a fresh
  // container. Passed straight through to the gateway child, which reads
  // this exact env var name. Required when LLM_AUTH_MODE=oauth.
  OPENCLAW_AUTH_PROFILE_SECRET_KEY: z.string().optional(),

  // Platform MCP — the console's MCP server. URL is optional; when
  // missing the agent simply has no outbound A2A (and no bundle). The
  // token authenticates THIS agent (knox_agent_* form) and is required
  // whenever the URL is set — without it the bundle fetch would 401 and
  // the agent would silently boot with no capabilities.
  PLATFORM_MCP_URL: z.string().url().optional(),
  PLATFORM_API_TOKEN: z.string().optional(),

  // Operator-configured MCP servers, delivered as a JSON blob so an agent can
  // be wired to ANY number of remote MCP servers from the console without a
  // vessel code change. Shape mirrors openclaw's mcp.servers:
  //   { "<name>": { "url": "https://…", "transport": "streamable-http",
  //                 "headers": { "Authorization": "Bearer ${SOME_TOKEN}" } } }
  // String values may reference other env vars as ${VAR} (expanded at boot),
  // so a secret lives in its own credential-bound env var rather than inline.
  // Parsed + merged into mcp.servers by buildOpenclawConfig; a malformed blob
  // is logged and skipped rather than failing boot. The reserved server name
  // "knoxville_platform" cannot be overridden here.
  OPENCLAW_MCP_SERVERS: z.string().optional(),

  // Optional per-agent tool policy, passed through to openclaw's
  // `tools.profile` / `tools.deny`. Default is unset → openclaw's own default
  // (no restriction), so leaving these blank changes nothing.
  //
  // Use them to constrain SINGLE-PURPOSE provider/SME agents (e.g. a SanMar or
  // Sports Inc agent that only runs one skill). Weaker models otherwise reach
  // for the wrong tool — spawning a local sub-agent (`sessions_spawn`) or
  // introspecting — instead of just running the skill. Removing those footguns
  // makes `exec` the obvious path. NOTE: openclaw's session/sub-agent tools are
  // LOCAL to this gateway and are NOT how Knoxville agents delegate to each
  // other (that goes through the knoxville_platform MCP), so denying them does
  // not affect real A2A delegation.
  //   OPENCLAW_TOOLS_PROFILE — one of minimal|coding|messaging|full (base allowlist).
  //   OPENCLAW_TOOLS_DENY    — comma/space-separated tool ids or groups, e.g.
  //                            "group:sessions" or "sessions_spawn,subagents".
  OPENCLAW_TOOLS_PROFILE: z.enum(["minimal", "coding", "messaging", "full"]).optional(),
  OPENCLAW_TOOLS_DENY: z.string().optional(),

  // Autonomous heartbeat cadence → openclaw.json agents.defaults.heartbeat.every.
  //
  // openclaw runs a periodic "heartbeat" turn on the default (`main`) agent: a
  // FULL model inference (the entire system prompt + every tool schema replayed
  // for a tiny "nothing to do" ack, whose delivery target defaults to "none").
  // It is ON by default at 30m for the default agent EVEN WHEN IDLE, so a vessel
  // that no one is messaging still bills ~one full input every 30 minutes,
  // around the clock — the overnight/weekend inference cost with no user-visible
  // output. These agents are reactive (all conversation arrives via the shim),
  // so that autonomous tick is pure waste here. We therefore DISABLE it by
  // default (see resolveHeartbeatEvery) and expose this per-agent opt-in:
  //   unset / "" / "off" / "0" / "none" / "disabled" → heartbeat disabled
  //   any openclaw duration ("8h", "2h", "30m", …)   → re-enabled at that cadence
  // Emitting every:"0" makes openclaw's heartbeat runner skip scheduling
  // (resolveHeartbeatIntervalMs → null → "heartbeat: disabled"); a bad duration
  // parses to null and stays safely disabled rather than failing boot.
  OPENCLAW_HEARTBEAT_EVERY: z.string().optional(),

  // ── Long-running tasks (console migration 0047) ──────────────────────────
  //
  // How many tasks this vessel executes at once. Tasks run detached from any
  // HTTP request, so this is the real throughput knob — and the real cost knob,
  // since every lane is a concurrent model stream.
  //
  // NOTE the separate credential lane below: this cap governs ordinary tasks.
  AGENT_MAX_CONCURRENT_TASKS: z
    .string()
    .optional()
    .default("3")
    .transform((v) => Math.max(1, Number.parseInt(v, 10) || 3)),

  // How credential-carrying (delegated) tasks share the vessel.
  //
  //   parallel (default) — they run like any other task, up to
  //     AGENT_MAX_CONCURRENT_TASKS. Correct because the openclaw
  //     `before_tool_call` plugin injects credentials keyed by ctx.sessionKey,
  //     so every concurrent task gets exactly its own caller's secrets. This is
  //     what an SME agent whose whole job is accepting delegations needs.
  //
  //   serial — at most ONE credential-carrying task at a time. The fallback for
  //     a deployment where the plugin path is not available (an openclaw old
  //     enough that the embedded run skips before_tool_call, a tools.profile
  //     that strips plugins, an exec host that bypasses the wrapper). There the
  //     only injector is the exec shim, which openclaw gives no session key and
  //     which therefore fails closed whenever two delegated turns overlap —
  //     correct, but it caps delegated throughput at 1.
  //
  // Flip to `serial` if skills start reporting missing credentials under load;
  // that is the signature of the plugin path not firing. See
  // CONSOLE_INTEGRATION.md "Credentials on a delegated task".
  AGENT_DELEGATED_TASK_MODE: z
    .enum(["parallel", "serial"])
    .optional()
    .default("parallel"),

  // Tasks accepted but not yet started. A full queue rejects new starts with a
  // 429 so the platform fails the task loudly instead of silently sitting on it.
  AGENT_MAX_QUEUED_TASKS: z
    .string()
    .optional()
    .default("50")
    .transform((v) => Math.max(1, Number.parseInt(v, 10) || 50)),

  // How often a running task reports proof-of-life to the platform. Must stay
  // comfortably under the console's TASK_HEARTBEAT_GRACE_SECONDS (default 300s)
  // or healthy tasks get reaped as dead.
  AGENT_TASK_HEARTBEAT_SECONDS: z
    .string()
    .optional()
    .default("30")
    .transform((v) => Math.max(5, Number.parseInt(v, 10) || 30)),

  // Ports
  AGENT_HTTP_PORT: z
    .string()
    .optional()
    .default("8080")
    .transform((v) => Number.parseInt(v, 10)),
  OPENCLAW_GATEWAY_PORT: z
    .string()
    .optional()
    .default("18789")
    .transform((v) => Number.parseInt(v, 10)),

  // openclaw state directory (where openclaw.json + workspace live).
  // Distinct from openclaw's own OPENCLAW_HOME env var, which it treats
  // as the user-home equivalent and appends `.openclaw` to.
  OPENCLAW_STATE_DIR: z.string().default("/home/agent/.openclaw"),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),
}).superRefine((env, ctx) => {
  if (env.LLM_AUTH_MODE === "oauth" && !env.OPENCLAW_AUTH_PROFILE_SECRET_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["OPENCLAW_AUTH_PROFILE_SECRET_KEY"],
      message:
        "required when LLM_AUTH_MODE=oauth (stable seed that keeps the encrypted OAuth store portable across redeploys)",
    });
  }
});

export type AgentEnv = z.infer<typeof Schema>;

export function loadEnv(): AgentEnv {
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
