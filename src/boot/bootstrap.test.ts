import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentBundle } from "../bundle/types.js";
import type { AgentEnv } from "../env.js";
import { manifestDigest, sha256Hex, type SyncPlanRequest, type SyncPlanSkill } from "../skills/contract.js";
import { BlobCache, blobCacheDir } from "../skills/fetch.js";
import { readLock, writeLock } from "../skills/lock.js";
import type { PlanFetchResult, SkillSyncPlatform } from "../skills/plan.js";
import { SkillSync } from "../skills/sync.js";

// ── Everything bootstrap touches outside the volume is faked ────────────────
const h = vi.hoisted(() => ({
  bundle: null as AgentBundle | null,
  resetWorkspaceSkills: vi.fn(async (_dir: string) => {}),
  installBundleSkills: vi.fn(async () => []),
  installBootListSkills: vi.fn(async () => []),
  provisionSkillDeps: vi.fn(async () => {}),
}));

vi.mock("../provision/supabase-storage.js", () => ({
  AgentStorage: class {
    async downloadText() {
      return null;
    }
    async downloadShared() {
      return null;
    }
    async downloadJSON() {
      return null;
    }
    async uploadJSON() {}
  },
}));
vi.mock("../provision/pinnable-models.js", () => ({ fetchPinnableModelIds: async () => [] }));
vi.mock("../provision/agent-memory.js", () => ({
  MemoryCheckpoint: { fromEnv: () => ({ restore: async () => {} }) },
}));
vi.mock("../skills/boot-list.js", () => ({ loadBootListSkills: async () => [] }));
vi.mock("../skills/install.js", () => ({
  resetWorkspaceSkills: h.resetWorkspaceSkills,
  installBundleSkills: h.installBundleSkills,
  installBootListSkills: h.installBootListSkills,
}));
vi.mock("../skills/deps.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills/deps.js")>()),
  provisionSkillDeps: h.provisionSkillDeps,
}));
vi.mock("../bundle/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bundle/client.js")>()),
  bundleClientFromEnv: () =>
    h.bundle
      ? { fetchBundle: async () => h.bundle, fetchMemoryDigest: async () => null }
      : null,
}));

const { bootstrap, RequiredSkillsUnavailableError, requiredSkillRefs } = await import("./bootstrap.js");

// ── Fakes ───────────────────────────────────────────────────────────────────
const SKILL_MD = "---\nname: hello-world\ndescription: Say hello.\n---\n\n# hello\n";

class Platform implements SkillSyncPlatform {
  mode: "ok" | "legacy" | "down" = "ok";
  skills: SyncPlanSkill[] = [];
  async getSkillSyncPlan(_req: SyncPlanRequest): Promise<PlanFetchResult> {
    if (this.mode === "legacy") return { kind: "legacy", detail: "Unknown tool: get_skill_sync_plan" };
    if (this.mode === "down") throw new Error("platform MCP 502");
    return { kind: "plan", plan: { generation: 1, skills: this.skills } };
  }
  async reportSkillSync(): Promise<void> {}
}

function helloVersion(): SyncPlanSkill {
  const sha = sha256Hex(SKILL_MD);
  const files = [{ path: "SKILL.md", sha256: sha, size: Buffer.byteLength(SKILL_MD), executable: false }];
  return {
    slug: "hello-world",
    skill_id: "skill-hello",
    version_id: "ver-1",
    version: "1.0.0",
    content_sha256: manifestDigest(files),
    managed_by: "capability",
    required: true,
    skill_key: null,
    requirements: { env: [], bins: [], any_bins: [], uv: [], primary_env: null, skill_key: null, os: [] },
    files: files.map((f) => ({ ...f, url: `https://blobs.test/${f.sha256}` })),
  };
}

function bundleRequiring(ref: string): AgentBundle {
  return {
    agent: { uid: "0123456789abcdef", orgId: "acme" },
    assignments: [
      {
        listing: { id: "l", slug: "listing", name: "L", listingStatus: "live", availability: "public" },
        capability: {
          name: "Cap",
          description: "",
          actionType: "x",
          mode: "read_only",
          requiresHumanApproval: false,
          requiresUserAuth: false,
          skill: { source: "clawhub", ref, version: "1.0.0" },
        },
      },
    ],
    connections: [],
  };
}

let stateDir: string;
let platform: Platform;

function env(): AgentEnv {
  return {
    AGENT_UID: "0123456789abcdef",
    AGENT_ORG: "acme",
    AGENT_ROLE: "generic",
    SUPABASE_JWT_SECRET: "secret",
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
    OPENCLAW_STATE_DIR: stateDir,
    AGENT_TOOL_CALL_TRACKING: true,
    OPENCLAW_TOOL_SEARCH: "off",
    LOG_LEVEL: "info",
  } as AgentEnv;
}

function sync(): SkillSync {
  return new SkillSync({
    stateDir,
    platform,
    blobs: new BlobCache({
      dir: blobCacheDir(stateDir),
      fetch: async () => new Response(SKILL_MD),
    }),
    depsRunner: {
      interpreter: async () => ({ python: "/p", venvId: "v" }),
      install: async () => ({ ok: true }),
      installChromium: async () => ({ ok: true }),
    },
    eligibility: null,
  });
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "knox-boot-"));
  platform = new Platform();
  h.bundle = null;
  vi.clearAllMocks();
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("bootstrap skills integration", () => {
  it("library mode: reconciles (no wipe) and the final openclaw.json carries the lock's revs", async () => {
    platform.skills = [helloVersion()];
    // A stray pre-library folder: quarantined, not wiped.
    await mkdir(join(stateDir, "workspace", "skills", "stray"), { recursive: true });

    const result = await bootstrap(env(), { skillSync: sync() });

    expect(result.skillsMode).toBe("library");
    expect(h.resetWorkspaceSkills).not.toHaveBeenCalled();
    expect(h.installBundleSkills).not.toHaveBeenCalled();
    expect(await readFile(join(stateDir, "workspace", "skills", "hello-world", "SKILL.md"), "utf8")).toBe(SKILL_MD);
    const config = JSON.parse(await readFile(join(stateDir, "openclaw.json"), "utf8"));
    expect(config.gateway.reload).toEqual({ mode: "hot" });
    expect(config.skills).toEqual({
      allowBundled: ["skill-creator"],
      entries: { "hello-world": { config: { rev: helloVersion().content_sha256.slice(0, 12) } } },
    });
    expect(result.installedSkills.map((s) => s.ref)).toEqual(["hello-world"]);
  });

  it("legacy console (Unknown tool): runs today's wipe + bundle + boot-list path and drops the lock", async () => {
    platform.mode = "legacy";
    await writeLock(stateDir, { version: 1, generation: 4, skills: {} });

    const result = await bootstrap(env(), { skillSync: sync() });

    expect(result.skillsMode).toBe("legacy");
    expect(h.resetWorkspaceSkills).toHaveBeenCalledTimes(1);
    expect(h.installBootListSkills).toHaveBeenCalledTimes(1);
    expect(h.provisionSkillDeps).toHaveBeenCalledTimes(1);
    expect((await readLock(stateDir)).existed).toBe(false);
  });

  it("no platform MCP: the legacy path, as before", async () => {
    const result = await bootstrap(env(), { skillSync: null });
    expect(result.skillsMode).toBe("legacy");
    expect(h.resetWorkspaceSkills).toHaveBeenCalledTimes(1);
  });

  it("plan unavailable + a capability skill with nothing installed → fail loud", async () => {
    platform.mode = "down";
    h.bundle = bundleRequiring("hello-world");
    await expect(bootstrap(env(), { skillSync: sync() })).rejects.toBeInstanceOf(RequiredSkillsUnavailableError);
  });

  it("plan unavailable but the last-known-good set covers the capability → boots", async () => {
    platform.skills = [helloVersion()];
    await bootstrap(env(), { skillSync: sync() });

    platform.mode = "down";
    h.bundle = bundleRequiring("skill-hello"); // a library ref (skill id) resolves through the lock
    const result = await bootstrap(env(), { skillSync: sync() });

    expect(result.skillsMode).toBe("library");
    expect(await stat(join(stateDir, "workspace", "skills", "hello-world", "SKILL.md"))).toBeTruthy();
    const config = JSON.parse(await readFile(join(stateDir, "openclaw.json"), "utf8"));
    expect(Object.keys(config.skills.entries)).toEqual(["hello-world"]);
  });

  it("requiredSkillRefs collects each capability's skill ref once", () => {
    const b = bundleRequiring("a");
    b.assignments.push(b.assignments[0]!, {
      ...b.assignments[0]!,
      capability: { ...b.assignments[0]!.capability, skill: { source: "clawhub", ref: "b", version: "1" } },
    });
    expect(requiredSkillRefs(b)).toEqual(["a", "b"]);
    expect(requiredSkillRefs(null)).toEqual([]);
  });
});
