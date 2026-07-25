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

/** The platform constitution shipped in the image (see `prompts/constitution.md`).
 *  Resolved relative to this module so it works from both `src/` (tests) and
 *  `dist/` (runtime): in each layout `provision/` is one dir below the repo root
 *  that holds `prompts/`. This is the guaranteed fallback so a brand-new or
 *  disaster-recovered agent is never soulless even if Storage is empty. */
const IMAGE_CONSTITUTION_PATH = fileURLToPath(
  new URL("../../prompts/constitution.md", import.meta.url),
);

/** Bucket-root Storage key for the (optional) platform constitution override.
 *  Org-agnostic — the same soul for every agent — so it lives outside the
 *  per-agent `orgs/{org}/agents/{uid}/` prefix. */
const CONSTITUTION_STORAGE_KEY = "platform/constitution.md";

/**
 * Load the platform constitution: the Storage override wins when present and
 * non-empty, else the image copy. Never returns empty — the image copy is
 * bundled, so this is the one prompt layer that is always available.
 */
export async function loadConstitution(env: AgentEnv): Promise<string> {
  const override = await new AgentStorage(env).downloadShared(
    CONSTITUTION_STORAGE_KEY,
  );
  if (override && override.trim()) return override;
  return await readFile(IMAGE_CONSTITUTION_PATH, "utf8");
}

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
 * Dir holding the delegated-credential exec shim (a `python3` that injects this
 * turn's brokered creds, then re-execs the real venv python3 — see Dockerfile +
 * docker/knox-python3-shim.py). It is prepended AHEAD of the venv so that on a
 * skill's `python3 ...` the exec tool resolves the shim first. This is the
 * runtime's per-turn credential-injection path for delegated A2A turns, which
 * openclaw's chat-completions run can't reach via `before_tool_call` plugins.
 * The shim itself re-execs `${SKILLS_VENV_BIN}/python3`, so `requests` etc. are
 * still on hand. Only `python3` is shadowed; `uv`/`pip`/other bins still resolve
 * to the venv. Scoped to the exec PATH only — boot-time python3 is unaffected.
 */
const EXEC_SHIM_BIN = "/opt/knox-exec-shim";

/**
 * Max characters per workspace bootstrap file (SOUL.md) before openclaw
 * truncates it in the injected context (`agents.defaults.bootstrapMaxChars`,
 * openclaw default 12000). The console-authored SOUL.md already runs ~12.5k on
 * real agents, so at the default openclaw silently drops the tail — which is
 * exactly where turn-behavior/delegation guidance tends to live. Bump it to give
 * comfortable headroom; still far under openclaw's 60000 bootstrapTotalMaxChars.
 */
const BOOTSTRAP_MAX_CHARS = 24000;

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
  /** Raw `memory/system_prompt.md` from storage, or null if absent. Repurposed
   *  as the optional `# CHARTER` layer (extended domain prose), NOT the base —
   *  the base soul is now the constitution (see loadConstitution). */
  base: string | null;
  /** Raw `memory/identity.md` from storage, or null if absent. */
  identity: string | null;
  /** Raw `memory/boot.md` from storage, or null if absent. */
  boot: string | null;
  /** Raw `memory/playbook.seed.md` from storage, or null if absent. Console-
   *  authored operator notes, rendered read-only into SOUL as `# OPERATOR
   *  NOTES`. Distinct from the agent-owned `memory/playbook.md`. */
  playbookSeed: string | null;
}

/** Fetch the console-authored prompt blobs from storage in one pass. Bootstrap
 *  uses these to build the assembled SOUL.md. (The agent-owned `playbook.md` and
 *  `notes/` are handled by MemoryCheckpoint, not loaded here.) */
export async function loadPromptBlobs(env: AgentEnv): Promise<PromptBlobs> {
  const storage = new AgentStorage(env);
  const [base, identity, boot, playbookSeed] = await Promise.all([
    storage.downloadText("memory/system_prompt.md"),
    storage.downloadText("memory/identity.md"),
    storage.downloadText("memory/boot.md"),
    storage.downloadText("memory/playbook.seed.md"),
  ]);
  return { base, identity, boot, playbookSeed };
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

  // openclaw.json is also written earlier in bootstrap (before any skill
  // install) so the `openclaw skills install` CLI validates against a current,
  // valid config. Re-writing it here keeps renderWorkspace self-contained and
  // idempotent — same env in, same file out.
  await writeOpenclawConfig(env);

  log.info("workspace rendered", {
    stateDir,
    workspace: ws,
    has_base_prompt: blobs.base != null,
    has_identity: blobs.identity != null,
    has_boot: blobs.boot != null,
    mcp_platform_attached: Boolean(env.PLATFORM_MCP_URL),
  });
}

/** Public so bootstrap can use it as the identity layer when storage has
 *  no `memory/identity.md`. The base soul is the constitution now, so this only
 *  needs to supply a usable generic identity — never the old "unconfigured" stub. */
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

/**
 * Write just `openclaw.json` (not SOUL/AGENTS/TOOLS) into the state dir.
 *
 * Called at TWO points in a boot: early in bootstrap — before any
 * `openclaw skills install`, whose CLI loads + validates the config and
 * refuses to run against an invalid one — and again from renderWorkspace at
 * the end. The early write matters because the on-disk openclaw.json may be a
 * stale, invalid config left by a previous failed boot (e.g. a since-fixed bad
 * provider block); without a fresh valid file first, every boot-list skill
 * install fails and the agent boots without its skills. buildOpenclawConfig is
 * a pure function of env, so both writes produce identical bytes.
 */
export async function writeOpenclawConfig(env: AgentEnv): Promise<void> {
  const stateDir = env.OPENCLAW_STATE_DIR;
  const ws = join(stateDir, "workspace");
  await mkdir(ws, { recursive: true });
  const config = buildOpenclawConfig(env, ws);
  await writeFile(
    join(stateDir, "openclaw.json"),
    JSON.stringify(config, null, 2),
    "utf8",
  );
}

/**
 * Parse `OPENCLAW_TOOLS_DENY` (comma/space/newline-separated tool ids or groups)
 * into a de-duplicated, order-preserving list for openclaw's `tools.deny`. An
 * empty / missing value yields `[]` (no deny entry is emitted at all). Exported
 * for unit tests.
 */
export function parseToolsDeny(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of raw.split(/[\s,]+/)) {
    const t = tok.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
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

  // Optional per-agent tool deny-list (see env.ts / the tools block below).
  const toolsDeny = parseToolsDeny(env.OPENCLAW_TOOLS_DENY);

  // openclaw.json shape derived from `openclaw config schema` for the
  // pinned CLI version. openclaw 2026.5.x rejects unknown top-level keys
  // with "<root>: Invalid input", so anything we emit here must match the
  // schema exactly — comments on each block call out the key path.
  const config: Record<string, unknown> = {
    agents: {
      defaults: {
        workspace,
        // Stop openclaw truncating the (already ~12.5k) SOUL.md at its 12000
        // default, which silently drops the tail of the system prompt.
        bootstrapMaxChars: BOOTSTRAP_MAX_CHARS,
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
    // Prepend, in order: (1) the delegated-credential exec shim, then (2) the
    // skills venv. openclaw rebuilds the exec PATH from a minimal login shell
    // and ignores per-call env.PATH, so `tools.exec.pathPrepend` is the only way
    // to control what a skill's bare `python3 scripts/foo.py` resolves to. The
    // shim goes first so it can inject this turn's brokered credentials (the
    // delegated A2A path openclaw's chat-completions run can't reach via
    // before_tool_call plugins) and then re-exec the venv python3 — which is why
    // the venv still needs to be on PATH right behind it (for `requests` and for
    // `uv`/`pip`, which the shim doesn't shadow). Applies to every agent; on a
    // non-delegated turn the shim finds nothing staged and is a no-op.
    //
    // Optional per-agent tool policy (OPENCLAW_TOOLS_PROFILE / _DENY): default
    // unset → openclaw's own default (no restriction). Ops can set these on a
    // single-purpose provider/SME agent to strip footgun tools (e.g.
    // `group:sessions` — local sub-agent spawning, which a weak model reaches
    // for instead of running the skill, and which is NOT the Knoxville
    // cross-agent delegation path anyway). See env.ts.
    tools: {
      exec: {
        pathPrepend: [EXEC_SHIM_BIN, SKILLS_VENV_BIN],
      },
      ...(env.OPENCLAW_TOOLS_PROFILE ? { profile: env.OPENCLAW_TOOLS_PROFILE } : {}),
      ...(toolsDeny.length > 0 ? { deny: toolsDeny } : {}),
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
    //   - external OpenAI-compatible endpoint (Groq / DeepSeek / OpenRouter /
    //     self-hosted Ollama box) → { apiKey, baseUrl } from LLM_API_KEY +
    //     LLM_BASE_URL
    //   - in-container Ollama → { apiKey: "ollama", baseUrl: loopback } with
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
 * NOTE: the provider endpoint override key is `baseUrl` (the schema sibling
 * of `apiKey` under a provider entry), verified against `openclaw config
 * schema` for the pinned CLI (2026.5.20). openclaw rejects the camelCase
 * `baseURL` with `models.providers.<provider>: Invalid input` and refuses to
 * start, so this casing matters — see README "Verification status".
 */
function buildProviderConfig(env: AgentEnv): Record<string, unknown> | null {
  const provider = env.LLM_PROVIDER.trim().toLowerCase();

  // Endpoint: explicit override wins; else the ollama provider falls back to
  // the in-container server. Every other provider uses openclaw's built-in
  // hosted default (no baseUrl emitted).
  const baseUrl =
    env.LLM_BASE_URL ?? (provider === "ollama" ? LOCAL_OLLAMA_BASE_URL : undefined);

  // Key: use LLM_API_KEY when present. Ollama's OpenAI-compatible endpoint
  // ignores the key, but OpenAI-compatible clients often reject an empty one,
  // so fall back to a harmless placeholder for ollama.
  const apiKey = env.LLM_API_KEY || (provider === "ollama" ? "ollama" : undefined);

  const cfg: Record<string, unknown> = {};
  if (apiKey) cfg.apiKey = apiKey;
  if (baseUrl) cfg.baseUrl = baseUrl;
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

function defaultAgents(env: AgentEnv): string {
  return `Identity: Knoxville AI platform agent \`${env.AGENT_UID}\`, serving
organization \`${env.AGENT_ORG}\`.

This agent has not been given a specific charter yet, so operate as a capable,
general-purpose assistant for your organization within the principles in your
constitution. Your granted skills and connections (below, when present) define
what you can do; lean on them, and build up your playbook and memory as you
learn how this organization likes to work. An operator can give you a sharper
identity any time from the console.`;
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
