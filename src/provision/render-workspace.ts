import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { AgentStorage } from "./supabase-storage.js";

/**
 * Renders an openclaw workspace from env vars + Supabase Storage, then
 * writes openclaw.json so `openclaw gateway` can boot cold against it.
 *
 * Workspace layout (matches openclaw defaults):
 *   $OPENCLAW_HOME/
 *     openclaw.json
 *     workspace/
 *       AGENTS.md       ← from Storage memory/identity.md
 *       SOUL.md         ← from Storage memory/system_prompt.md
 *       TOOLS.md        ← from Storage memory/boot.md (operational guidance)
 *       playbook.md     ← from Storage memory/playbook.md (writable)
 *       skills/         ← empty for now; populated by skill installs later
 */
export async function renderWorkspace(env: AgentEnv): Promise<void> {
  const home = env.OPENCLAW_HOME;
  const ws = join(home, "workspace");
  await mkdir(join(ws, "skills"), { recursive: true });

  const storage = new AgentStorage(env);

  // 1) Pull prompt blobs from Storage. Missing files are tolerated — we
  //    fall back to small built-in defaults so a freshly-provisioned agent
  //    boots even before the console has uploaded anything.
  const [systemPrompt, identity, boot, playbook] = await Promise.all([
    storage.downloadText("memory/system_prompt.md"),
    storage.downloadText("memory/identity.md"),
    storage.downloadText("memory/boot.md"),
    storage.downloadText("memory/playbook.md"),
  ]);

  await writeFile(
    join(ws, "SOUL.md"),
    systemPrompt ?? defaultSoul(env),
    "utf8",
  );
  await writeFile(
    join(ws, "AGENTS.md"),
    identity ?? defaultAgents(env),
    "utf8",
  );
  await writeFile(
    join(ws, "TOOLS.md"),
    boot ?? defaultTools(),
    "utf8",
  );
  if (playbook != null) {
    await writeFile(join(ws, "playbook.md"), playbook, "utf8");
  }

  // 2) Render openclaw.json.
  const config = buildOpenclawConfig(env, ws);
  await writeFile(
    join(home, "openclaw.json"),
    JSON.stringify(config, null, 2),
    "utf8",
  );

  log.info("workspace rendered", {
    home,
    workspace: ws,
    has_system_prompt: systemPrompt != null,
    has_identity: identity != null,
    has_boot: boot != null,
    has_playbook: playbook != null,
    mcp_platform_attached: Boolean(env.KNOXVILLE_PLATFORM_MCP_URL),
  });
}

function buildOpenclawConfig(env: AgentEnv, workspace: string): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};
  if (env.KNOXVILLE_PLATFORM_MCP_URL) {
    mcpServers.knoxville_platform = {
      url: env.KNOXVILLE_PLATFORM_MCP_URL,
      transport: "streamable-http",
      headers: env.KNOXVILLE_PLATFORM_MCP_TOKEN
        ? { Authorization: `Bearer ${env.KNOXVILLE_PLATFORM_MCP_TOKEN}` }
        : {},
    };
  }

  // openclaw.json shape derived from docs/gateway/configuration.md and
  // docs/gateway/configuration-reference.md. The shape is conservative —
  // keys openclaw doesn't recognize will be ignored; missing keys fall to
  // safe defaults.
  return {
    agents: {
      defaults: {
        workspace,
        model: {
          primary: `${env.LLM_PROVIDER}/${env.LLM_MODEL}`,
        },
      },
    },
    providers: env.LLM_API_KEY
      ? {
          [env.LLM_PROVIDER]: { apiKey: env.LLM_API_KEY },
        }
      : {},
    gateway: {
      port: env.OPENCLAW_GATEWAY_PORT,
      bind: "127.0.0.1",
      auth: { token: env.OPENCLAW_GATEWAY_TOKEN },
    },
    mcp: {
      servers: mcpServers,
    },
    // We don't bind any native channels — all conversation flows through
    // the shim's HTTP surface, which is what the knoxville console talks to.
    channels: {},
  };
}

function defaultSoul(env: AgentEnv): string {
  return `# SOUL

You are a Knoxville AI platform agent (uid \`${env.AGENT_UID}\`) belonging
to organization \`${env.AGENT_ORG}\`. Your system prompt has not been
configured yet — ask the operator (via the console) to set it under
\`memory/system_prompt.md\` in agent storage.

Until then, behave as a careful, general-purpose assistant. Decline tasks
that require domain authority you have not been granted.
`;
}

function defaultAgents(env: AgentEnv): string {
  return `# AGENTS

Identity: Knoxville platform agent \`${env.AGENT_UID}\` (org \`${env.AGENT_ORG}\`).

Role slug: \`${env.AGENT_ROLE}\`. This is a general-purpose openclaw vessel;
specific capabilities are added by installing skills into
\`workspace/skills/\` and by attaching MCP servers in \`openclaw.json\`.
`;
}

function defaultTools(): string {
  return `# TOOLS

Available tool surfaces:

- Built-in openclaw tools (browser, code execution, etc.) per the workspace
  configuration.
- Any MCP servers listed under \`mcp.servers\` in \`openclaw.json\`. The
  \`knoxville_platform\` server (when attached) exposes drive-thru discovery
  and agent-to-agent conversation primitives.

Skills installed under \`workspace/skills/\` will appear here once present.
`;
}
