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

  // Platform MCP — optional; when missing the agent simply has no outbound A2A.
  KNOXVILLE_PLATFORM_MCP_URL: z.string().url().optional(),
  KNOXVILLE_PLATFORM_MCP_TOKEN: z.string().optional(),

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
