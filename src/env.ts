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
  // openclaw.json as models.providers.<LLM_PROVIDER>.baseURL so the agent
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
