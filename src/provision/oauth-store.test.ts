import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stored: { payload: unknown } = { payload: null };
vi.mock("./supabase-storage.js", () => ({
  AgentStorage: class {
    async downloadJSON() {
      return stored.payload;
    }
  },
}));

import type { AgentEnv } from "../env.js";
import { oauthStoreTarget, restoreOAuthStore } from "./oauth-store.js";

describe("oauthStoreTarget", () => {
  const state = "/home/agent/.openclaw";

  it.each([
    ["agents/main/agent/auth-profiles.json", `${state}/agents/main/agent/auth-profiles.json`],
    ["agents/main/agent/auth.json", `${state}/agents/main/agent/auth.json`],
    ["credentials/oauth.json", `${state}/credentials/oauth.json`],
  ])("accepts %s", (rel, abs) => {
    expect(oauthStoreTarget(state, rel)).toBe(abs);
  });

  it.each([
    "../../app/openclaw-plugins/x/index.js",
    "agents/../../outside/auth.json",
    "agents/main/../../../etc/auth.json",
    "/etc/auth.json",
    "/home/agent/.openclaw/agents/main/auth.json",
    "agents\\..\\..\\auth.json",
    "agents/./auth.json",
    "agents//auth.json",
    "agents/main/agent/index.js",
    "agents/main/agent/auth-profiles.json.bak",
    "workspace/skills/x/auth.json",
    "openclaw.json",
    "auth.json",
    "agents/auth.json\u0000.js",
    "agents/m a/auth.json",
    "agents/a/b/c/d/e/f/g/auth.json",
    "",
    42,
    null,
  ])("refuses %j", (rel) => {
    expect(oauthStoreTarget(state, rel)).toBeNull();
  });
});

describe("restoreOAuthStore", () => {
  let base: string;
  let stateDir: string;
  let env: AgentEnv;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "oauth-store-"));
    stateDir = join(base, "state");
    await mkdir(stateDir, { recursive: true });
    env = { OPENCLAW_STATE_DIR: stateDir } as AgentEnv;
  });
  afterEach(async () => {
    stored.payload = null;
    await rm(base, { recursive: true, force: true });
  });

  it("writes the expected auth files under the state dir (0600)", async () => {
    stored.payload = {
      version: 1,
      savedAt: "2026-01-01T00:00:00Z",
      files: {
        "agents/main/agent/auth-profiles.json": "enc-1",
        "credentials/oauth.json": "enc-2",
      },
    };
    expect(await restoreOAuthStore(env)).toBe(2);
    expect(await readFile(join(stateDir, "agents/main/agent/auth-profiles.json"), "utf8")).toBe("enc-1");
    expect(await readFile(join(stateDir, "credentials/oauth.json"), "utf8")).toBe("enc-2");
    expect((await stat(join(stateDir, "credentials/oauth.json"))).mode & 0o777).toBe(0o600);
  });

  it("is a no-op when nothing is stored", async () => {
    stored.payload = null;
    expect(await restoreOAuthStore(env)).toBe(0);
    stored.payload = { version: 1, files: ["agents/main/auth.json"] };
    expect(await restoreOAuthStore(env)).toBe(0);
  });

  it("skips traversal, absolute and unexpected names but restores the valid entry", async () => {
    stored.payload = {
      version: 1,
      files: {
        "../escape/auth.json": "x",
        "agents/../../escape/auth.json": "x",
        [join(base, "abs", "auth.json")]: "x",
        "agents/main/agent/plugin.js": "x",
        "agents/main/agent/auth.json": 7,
        "agents/main/agent/auth-profiles.json": "ok",
      },
    };
    expect(await restoreOAuthStore(env)).toBe(1);
    expect(await readdir(base)).toEqual(["state"]);
    expect(await readdir(join(stateDir, "agents/main/agent"))).toEqual(["auth-profiles.json"]);
  });

  it("does not write through a symlinked directory", async () => {
    const outside = join(base, "outside");
    await mkdir(outside);
    await mkdir(join(stateDir, "agents"));
    await symlink(outside, join(stateDir, "agents", "main"));
    stored.payload = { version: 1, files: { "agents/main/auth-profiles.json": "x" } };
    expect(await restoreOAuthStore(env)).toBe(0);
    expect(await readdir(outside)).toEqual([]);
  });

  it("does not write through a symlinked root", async () => {
    const outside = join(base, "outside");
    await mkdir(outside);
    await symlink(outside, join(stateDir, "credentials"));
    stored.payload = { version: 1, files: { "credentials/oauth.json": "x" } };
    expect(await restoreOAuthStore(env)).toBe(0);
    expect(await readdir(outside)).toEqual([]);
  });

  it("does not follow a symlink at the file itself", async () => {
    const victim = join(base, "victim.js");
    await writeFile(victim, "original");
    await mkdir(join(stateDir, "credentials"));
    await symlink(victim, join(stateDir, "credentials", "oauth.json"));
    stored.payload = { version: 1, files: { "credentials/oauth.json": "x" } };
    expect(await restoreOAuthStore(env)).toBe(0);
    expect(await readFile(victim, "utf8")).toBe("original");
  });
});
