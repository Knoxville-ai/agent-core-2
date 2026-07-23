import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { AgentStorage } from "./supabase-storage.js";

/** Id + on-disk directory of the delegated-credentials OpenClaw plugin shipped in
 *  this repo (see `openclaw-plugins/`). Resolved relative to this module so it
 *  works from both `src/` (unit tests) and `dist/` (runtime) — in each layout
 *  `provision/` is one dir below the repo root that holds `openclaw-plugins/`. */
export const DELEGATED_CREDS_PLUGIN_ID = "knox-delegated-credentials";
const DELEGATED_CREDS_PLUGIN_DIR = fileURLToPath(
  new URL("../../openclaw-plugins/delegated-credentials", import.meta.url),
);

/**
 * `bin/` of the dedicated Python venv the image builds (see Dockerfile:
 * `/opt/skills-venv`), where every installed skill's `install.uv` deps land
 * (see ../skills/deps.ts). It MUST be prepended to the exec tool's PATH: on
 * `host=gateway` openclaw rebuilds the exec PATH from the login shell — a
 * minimal `/usr/local/bin:/usr/bin:/bin` that does NOT carry the image's
 * `ENV PATH` — and rejects per-call `env.PATH` overrides, so without this a
 * skill's `python3 scripts/foo.py` resolves to the system interpreter and dies
 * with `ModuleNotFoundError: requests`. `tools.exec.pathPrepend` is the one
 * supported lever that survives that rebuild (it merges to the FRONT, ahead of
 * the login-shell PATH). See docs/tools/exec.md "PATH handling".
 */
const SKILLS_VENV_BIN = "/opt/skills-venv/bin";

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
 *       skills/         ← populated by skill installs (see ../skills/install.ts)
 *
 * NOTE: playbook.md (and the agent-authored notes/ area) are NOT rendered here.
 * They are agent-owned: restored with volume-wins precedence and mirrored back
 * to Storage by MemoryCheckpoint (see ./agent-memory.ts). Rendering them from
 * Storage unconditionally here would clobber the agent's live edits every boot.
 */

export interface PromptBlobs {
  /** Raw `memory/system_prompt.md` from storage, or null if absent. */
  base: string | null;
  /** Raw `memory/identity.md` from storage, or null if absent. */
  identity: string | null;
  /** Raw `memory/boot.md` from storage, or null if absent. */
  boot: string | null;
}

/** Fetch the console-authored prompt blobs from storage in one pass. Bootstrap
 *  uses these to build the per-capability assembled SOUL.md. (playbook.md is
 *  agent-owned and handled by MemoryCheckpoint, not loaded here.) */
export async function loadPromptBlobs(env: AgentEnv): Promise<PromptBlobs> {
  const storage = new AgentStorage(env);
  const [base, identity, boot] = await Promise.all([
    storage.downloadText("memory/system_prompt.md"),
    storage.downloadText("memory/identity.md"),
    storage.downloadText("memory/boot.md"),
  ]);
  return { base, identity, boot };
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
  // playbook.md is intentionally NOT written here — see the header note. It is
  // restored (volume-wins) and mirrored by MemoryCheckpoint (./agent-memory.ts).

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

/**
 * Parse the OPENCLAW_MCP_SERVERS env blob into openclaw `mcp.servers` entries.
 *
 * The blob is a JSON object keyed by server name, each value an openclaw MCP
 * server config (`{ url, transport, headers?, … }`). String values may embed
 * `${VAR}` references, expanded from `envSource` (default `process.env`) so a
 * secret can be kept in its own credential-bound env var instead of inlined.
 *
 * Never throws: a malformed blob yields `{ servers: {}, error }` so the caller
 * can log and boot without the extra servers rather than crash. Non-object
 * entries are skipped. Exported for unit tests.
 */
export function parseExtraMcpServers(
  raw: string | undefined,
  envSource: Record<string, string | undefined> = process.env,
): { servers: Record<string, unknown>; error?: string } {
  if (!raw || !raw.trim()) return { servers: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      servers: {},
      error: `OPENCLAW_MCP_SERVERS is not valid JSON: ${(e as Error).message}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      servers: {},
      error: "OPENCLAW_MCP_SERVERS must be a JSON object of { name: serverConfig }",
    };
  }

  const expand = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.replace(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
        (_m, name: string) => envSource[name] ?? "",
      );
    }
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, expand(v)]),
      );
    }
    return value;
  };

  const servers: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(parsed as Record<string, unknown>)) {
    // Skip junk (null, arrays, scalars) — a server config must be an object.
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) continue;
    servers[name] = expand(cfg);
  }
  return { servers };
}

/** Exported for unit tests — builds the openclaw.json object from env + the
 *  rendered workspace path. */
export function buildOpenclawConfig(env: AgentEnv, workspace: string): Record<string, unknown> {
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

  // Operator-configured MCP servers (any number, any agent) delivered from the
  // console as the OPENCLAW_MCP_SERVERS JSON blob, merged in so the openclaw
  // runtime exposes their tools natively. The reserved knoxville_platform entry
  // above cannot be overridden.
  const extraMcp = parseExtraMcpServers(env.OPENCLAW_MCP_SERVERS);
  if (extraMcp.error) {
    log.warn("ignoring OPENCLAW_MCP_SERVERS", { reason: extraMcp.error });
  }
  for (const [name, cfg] of Object.entries(extraMcp.servers)) {
    if (name === "knoxville_platform") {
      log.warn("OPENCLAW_MCP_SERVERS cannot override reserved server", { name });
      continue;
    }
    mcpServers[name] = cfg;
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
        // GPT-5 / Codex models otherwise stall on "plan-only" turns and
        // rationalize NOT acting (e.g. falsely claiming they have no shell
        // access) instead of calling `exec`. The strict-agentic contract
        // makes openclaw reject plan-only completions, re-steer with an
        // act-now nudge, and surface an explicit blocked state instead.
        // openclaw scopes this to openai/openai-codex GPT-5-family runs and
        // collapses it to "default" for every other provider/model, so it's
        // a safe no-op for the Anthropic agents and only kicks in for the
        // Codex-OAuth vessels where this regression shows up. Schema-valid
        // for the pinned CLI (agents.defaults.embeddedPi.executionContract).
        embeddedPi: { executionContract: "strict-agentic" },
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
    // Make the skills venv's interpreter win on the exec tool's PATH. Skills
    // shell out with a bare `python3 scripts/foo.py`; on host=gateway openclaw
    // rebuilds that PATH from a minimal login shell and ignores env.PATH
    // overrides, so the ONLY way the venv (which holds each skill's `install.uv`
    // deps, e.g. `requests`) lands on PATH is this prepend. Applies to every
    // agent, not just delegated ones — any Python skill needs it.
    tools: {
      exec: {
        pathPrepend: [SKILLS_VENV_BIN],
      },
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
  } else {
    // Provider API keys AND endpoint overrides live under
    // models.providers.<name> — there is no top-level `providers` key in the
    // schema. We emit this block whenever we have a key and/or a base URL:
    //   - hosted API model with a key → { apiKey }
    //   - external OpenAI-compatible endpoint (Groq / DeepSeek / self-hosted
    //     Ollama box) → { apiKey, baseURL } from LLM_API_KEY + LLM_BASE_URL
    //   - in-container Ollama → { apiKey: "ollama", baseURL: loopback } with
    //     no LLM_API_KEY set (see buildProviderConfig)
    const providerConfig = buildProviderConfig(env);
    if (providerConfig) {
      config.models = {
        providers: {
          // Key MUST match the provider segment of model.primary above so
          // openclaw routes <provider>/<model> to this block.
          [env.LLM_PROVIDER]: providerConfig,
        },
      };
    }
  }

  // Knox delegated-credentials injector plugin — the OpenClaw half of the
  // agent-to-agent credential consumer (see openclaw-plugins/). Only wired when
  // the platform MCP is configured, since that is the only path by which a
  // delegated turn can arrive. Merges into any `plugins` block a prior step
  // (e.g. Codex OAuth) already set rather than clobbering it.
  if (env.PLATFORM_MCP_URL) {
    const plugins = (config.plugins as Record<string, unknown> | undefined) ?? {};
    const load = (plugins.load as { paths?: unknown } | undefined) ?? {};
    const paths = Array.isArray(load.paths) ? (load.paths as string[]) : [];
    plugins.load = { ...load, paths: [...paths, DELEGATED_CREDS_PLUGIN_DIR] };
    const entries = (plugins.entries as Record<string, unknown> | undefined) ?? {};
    entries[DELEGATED_CREDS_PLUGIN_ID] = { enabled: true };
    plugins.entries = entries;
    config.plugins = plugins;
  }

  return config;
}

/**
 * Loopback OpenAI-compatible endpoint of the in-container Ollama server (see
 * ../openclaw/ollama-process.ts). Ollama serves an OpenAI-compatible surface
 * at `/v1` on the same port as its native API. Only reachable when
 * LLM_PROVIDER=ollama, which is the only case that starts the server.
 */
export const LOCAL_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";

/**
 * Resolve the `models.providers.<provider>` block from the model env vars, or
 * null when there's nothing to emit (a hosted model with no key, e.g. an
 * OAuth-only or default-credential provider). Encodes the base-URL + key
 * defaults so both the external-endpoint and in-container-Ollama paths work.
 *
 * NOTE: the `baseURL` key is assumed to be the schema sibling of `apiKey`
 * under a provider entry (camelCase, matching `apiKey`). Verify against
 * `openclaw config schema` for the pinned CLI if a provider override is
 * rejected — see README "Verification status".
 */
function buildProviderConfig(env: AgentEnv): Record<string, unknown> | null {
  const provider = env.LLM_PROVIDER.trim().toLowerCase();

  // Endpoint: explicit override wins; else the ollama provider falls back to
  // the in-container server. Every other provider uses openclaw's built-in
  // hosted default (no baseURL emitted).
  const baseURL =
    env.LLM_BASE_URL ?? (provider === "ollama" ? LOCAL_OLLAMA_BASE_URL : undefined);

  // Key: use LLM_API_KEY when present. Ollama's OpenAI-compatible endpoint
  // ignores the key, but OpenAI-compatible clients often reject an empty one,
  // so fall back to a harmless placeholder for ollama.
  const apiKey = env.LLM_API_KEY || (provider === "ollama" ? "ollama" : undefined);

  const cfg: Record<string, unknown> = {};
  if (apiKey) cfg.apiKey = apiKey;
  if (baseURL) cfg.baseURL = baseURL;
  return Object.keys(cfg).length > 0 ? cfg : null;
}

/** Profile id + provider for the OpenClaw OpenAI-Codex OAuth flow. These
 *  strings are fixed by OpenClaw (provider id `openai-codex`, default
 *  profile `openai-codex:default`) — do not localize. */
export const CODEX_OAUTH_PROVIDER = "openai-codex";
export const CODEX_OAUTH_PROFILE_ID = "openai-codex:default";

/**
 * Flip an already-rendered openclaw.json (written at boot in API-key mode)
 * to Codex OAuth in place, then the caller restarts the gateway child. This
 * is the live "switch to OAuth" path: the token was just minted into the
 * encrypted store, so we add the oauth profile wiring + drop the API-key
 * block without a full Railway redeploy. Future boots reproduce this from
 * LLM_AUTH_MODE=oauth via buildOpenclawConfig.
 */
export async function switchConfigFileToOAuth(stateDir: string): Promise<void> {
  const path = join(stateDir, "openclaw.json");
  const config = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  applyCodexOAuthConfig(config);
  delete config.models; // remove the now-stale API-key block
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  log.info("openclaw.json switched to Codex OAuth in place", { path });
}

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
