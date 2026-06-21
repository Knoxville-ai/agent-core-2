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
 *   $OPENCLAW_STATE_DIR/
 *     openclaw.json
 *     workspace/
 *       AGENTS.md       ← from Storage memory/identity.md (the identity block)
 *       SOUL.md         ← assembled prompt (base + identity + capability fragments)
 *       TOOLS.md        ← from Storage memory/boot.md (operational guidance)
 *       playbook.md     ← from Storage memory/playbook.md (writable)
 *       skills/         ← populated by skill installs (see ../skills/install.ts)
 */

export interface PromptBlobs {
  /** Raw `memory/system_prompt.md` from storage, or null if absent. */
  base: string | null;
  /** Raw `memory/identity.md` from storage, or null if absent. */
  identity: string | null;
  /** Raw `memory/boot.md` from storage, or null if absent. */
  boot: string | null;
  /** Raw `memory/playbook.md` from storage, or null if absent. */
  playbook: string | null;
}

/** Fetch the four prompt blobs from storage in one pass. Bootstrap uses
 *  these to build the per-capability assembled SOUL.md. */
export async function loadPromptBlobs(env: AgentEnv): Promise<PromptBlobs> {
  const storage = new AgentStorage(env);
  const [base, identity, boot, playbook] = await Promise.all([
    storage.downloadText("memory/system_prompt.md"),
    storage.downloadText("memory/identity.md"),
    storage.downloadText("memory/boot.md"),
    storage.downloadText("memory/playbook.md"),
  ]);
  return { base, identity, boot, playbook };
}

export interface RenderWorkspaceInput {
  env: AgentEnv;
  /** Final SOUL.md contents — already assembled with capability prompts. */
  assembledSoul: string;
  blobs: PromptBlobs;
}

export async function renderWorkspace(input: RenderWorkspaceInput): Promise<void> {
  const { env, assembledSoul, blobs } = input;
  const stateDir = env.OPENCLAW_STATE_DIR;
  const ws = join(stateDir, "workspace");
  await mkdir(join(ws, "skills"), { recursive: true });

  await writeFile(join(ws, "SOUL.md"), assembledSoul, "utf8");
  await writeFile(
    join(ws, "AGENTS.md"),
    blobs.identity ?? defaultAgents(env),
    "utf8",
  );
  await writeFile(
    join(ws, "TOOLS.md"),
    blobs.boot ?? defaultTools(),
    "utf8",
  );
  if (blobs.playbook != null) {
    await writeFile(join(ws, "playbook.md"), blobs.playbook, "utf8");
  }

  const config = buildOpenclawConfig(env, ws);
  await writeFile(
    join(stateDir, "openclaw.json"),
    JSON.stringify(config, null, 2),
    "utf8",
  );

  log.info("workspace rendered", {
    stateDir,
    workspace: ws,
    has_base_prompt: blobs.base != null,
    has_identity: blobs.identity != null,
    has_boot: blobs.boot != null,
    has_playbook: blobs.playbook != null,
    mcp_platform_attached: Boolean(env.PLATFORM_MCP_URL),
  });
}

/** Public so bootstrap can pass it into the prompt assembler as the base
 *  layer when storage has no `system_prompt.md`. */
export function defaultBasePrompt(env: AgentEnv): string {
  return defaultSoul(env);
}

/** Public so bootstrap can use it as the identity layer when storage has
 *  no `memory/identity.md`. */
export function defaultIdentity(env: AgentEnv): string {
  return defaultAgents(env);
}

function buildOpenclawConfig(env: AgentEnv, workspace: string): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};
  if (env.PLATFORM_MCP_URL) {
    mcpServers.knoxville_platform = {
      url: env.PLATFORM_MCP_URL,
      transport: "streamable-http",
      headers: env.PLATFORM_API_TOKEN
        ? { Authorization: `Bearer ${env.PLATFORM_API_TOKEN}` }
        : {},
    };
  }

  // openclaw.json shape derived from `openclaw config schema` for the
  // pinned CLI version. openclaw 2026.5.x rejects unknown top-level keys
  // with "<root>: Invalid input", so anything we emit here must match the
  // schema exactly — comments on each block call out the key path.
  const config: Record<string, unknown> = {
    agents: {
      defaults: {
        workspace,
        model: {
          primary: `${env.LLM_PROVIDER}/${env.LLM_MODEL}`,
        },
      },
    },
    gateway: {
      port: env.OPENCLAW_GATEWAY_PORT,
      // openclaw refuses to start without gateway.mode=local (unless
      // --allow-unconfigured is passed). bind=loopback keeps the gateway
      // reachable only from the shim in the same container.
      mode: "local",
      bind: "loopback",
      auth: { mode: "token", token: env.OPENCLAW_GATEWAY_TOKEN },
      // The shim proxies user turns via the OpenAI-compatible chat
      // completions endpoint (mirrors what the original Python agent-core
      // does). Disabled by default in openclaw 2026.5.x, so opt in here.
      http: {
        endpoints: {
          chatCompletions: { enabled: true },
        },
      },
    },
    mcp: {
      servers: mcpServers,
    },
    // We don't bind any native channels — all conversation flows through
    // the shim's HTTP surface, which is what the knoxville console talks to.
    channels: {},
  };

  if (env.LLM_AUTH_MODE === "oauth") {
    // OpenAI-Codex (ChatGPT) OAuth. The secret token is NOT in this file —
    // it lives in OpenClaw's encrypted auth-profile store, minted on the
    // running container and restored at boot from Storage. Here we only
    // re-emit the non-secret wiring OpenClaw writes when you run its config
    // menus, so a from-scratch boot doesn't un-wire OAuth:
    //   - the openai + codex plugins enabled,
    //   - an `openai-codex:default` oauth profile,
    //   - auth.order routing the `openai` provider to that profile.
    // openclaw 2026.5.x routes openai/<model> through auth.order["openai"].
    applyCodexOAuthConfig(config);
  } else if (env.LLM_API_KEY) {
    // Provider API keys live under models.providers.<name>.apiKey — there
    // is no top-level `providers` key in the schema.
    config.models = {
      providers: {
        [env.LLM_PROVIDER]: { apiKey: env.LLM_API_KEY },
      },
    };
  }

  return config;
}

/** Profile id + provider for the OpenClaw OpenAI-Codex OAuth flow. These
 *  strings are fixed by OpenClaw (provider id `openai-codex`, default
 *  profile `openai-codex:default`) — do not localize. */
export const CODEX_OAUTH_PROVIDER = "openai-codex";
export const CODEX_OAUTH_PROFILE_ID = "openai-codex:default";

/** Mutates `config` in place to add the Codex OAuth auth block + plugins.
 *  Mirrors what `openclaw config` writes for a ChatGPT-OAuth setup so a
 *  cold boot reproduces it. The model stays `openai/<model>`. */
function applyCodexOAuthConfig(config: Record<string, unknown>): void {
  config.auth = {
    profiles: {
      [CODEX_OAUTH_PROFILE_ID]: {
        provider: CODEX_OAUTH_PROVIDER,
        mode: "oauth",
      },
    },
    // OpenClaw resolves openai/<model> auth via auth.order["openai"].
    order: {
      openai: [CODEX_OAUTH_PROFILE_ID],
      [CODEX_OAUTH_PROVIDER]: [CODEX_OAUTH_PROFILE_ID],
    },
  };
  config.plugins = {
    entries: {
      openai: { enabled: true },
      codex: { enabled: true },
    },
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
