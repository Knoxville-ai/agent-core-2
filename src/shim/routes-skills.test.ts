import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEnv } from "../env.js";
import type { SkillRequirement } from "../bundle/types.js";
import type { RevChange } from "../skills/refresh.js";
import type { InstalledSkill } from "../skills/resolver.js";
import type { SkillSync } from "../skills/sync.js";
import { HttpError } from "./auth.js";
import { routeSkills, safeSkillDir, type SkillsRouteDeps } from "./routes-skills.js";

const ROOT = "/home/agent/.openclaw/workspace/skills";

describe("safeSkillDir", () => {
  it("resolves a plain slug under the skills root", () => {
    expect(safeSkillDir(ROOT, "web-search")).toBe(resolve(ROOT, "web-search"));
  });

  it("allows a namespaced slug (org/skill)", () => {
    expect(safeSkillDir(ROOT, "acme/stripe")).toBe(resolve(ROOT, "acme/stripe"));
  });

  it("rejects path-traversal slugs (would rm -rf outside the workspace)", () => {
    expect(safeSkillDir(ROOT, "../etc")).toBeNull();
    expect(safeSkillDir(ROOT, "..")).toBeNull();
    expect(safeSkillDir(ROOT, "foo/../../bar")).toBeNull();
    expect(safeSkillDir(ROOT, "../../../etc/passwd")).toBeNull();
  });

  it("rejects the root itself and empty slugs", () => {
    expect(safeSkillDir(ROOT, ".")).toBeNull();
    expect(safeSkillDir(ROOT, "")).toBeNull();
  });

  it("rejects slugs with characters outside the grammar", () => {
    expect(safeSkillDir(ROOT, "foo bar")).toBeNull();
    expect(safeSkillDir(ROOT, "foo;rm -rf")).toBeNull();
    expect(safeSkillDir(ROOT, "foo\0bar")).toBeNull();
  });

  it("keeps a resolved path strictly beneath the root", () => {
    const out = safeSkillDir(ROOT, "web-search");
    expect(out).not.toBeNull();
    expect(out!.startsWith(resolve(ROOT) + sep)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Route harness
// ---------------------------------------------------------------------------

const TOKEN = "gw-token-0123456789abcdef";

function req(method: string, body?: unknown, auth: string | null = `Bearer ${TOKEN}`): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (stream as { headers: Record<string, string> }).headers = auth ? { authorization: auth } : {};
  (stream as { method: string }).method = method;
  return stream;
}

function res(): { res: ServerResponse; out: { status: number; json: () => unknown } } {
  const state = { status: 0, body: "" };
  const r = {
    writeHead(status: number) {
      state.status = status;
      return r;
    },
    end(payload?: string) {
      if (payload) state.body = payload;
    },
  } as unknown as ServerResponse;
  return {
    res: r,
    out: {
      get status() {
        return state.status;
      },
      json: () => JSON.parse(state.body),
    },
  };
}

/** A SkillSync stand-in exposing just what the routes use. */
function fakeSync(over: Partial<Record<keyof SkillSync, unknown>> & { mode?: string }): SkillSync {
  return { mode: "library", ...over } as unknown as SkillSync;
}

let stateDir: string;
let refreshes: RevChange[][];
let installs: SkillRequirement[];
let depsCalls: InstalledSkill[][];

function deps(sync: SkillSync | null, over: Partial<SkillsRouteDeps> = {}): SkillsRouteDeps {
  return {
    env: { OPENCLAW_GATEWAY_TOKEN: TOKEN, OPENCLAW_STATE_DIR: stateDir } as AgentEnv,
    sync,
    legacyInstaller: {
      async install(r, skillsDir) {
        installs.push(r);
        const dir = join(skillsDir, r.ref);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "SKILL.md"), `---\nname: ${r.ref}\n---\n`);
        return { ref: r.ref, version: r.version, path: dir, source: "clawhub" };
      },
    },
    provisionDeps: async (skills) => {
      depsCalls.push(skills);
    },
    refresh: async (changes) => {
      refreshes.push(changes);
    },
    syncWaitMs: 1_000,
    ...over,
  };
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "knox-routes-skills-"));
  refreshes = [];
  installs = [];
  depsCalls = [];
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("routeSkills auth", () => {
  it.each([null, "Bearer wrong-token-0000000000", "Basic abc"])("rejects authorization %j with 401", async (auth) => {
    const { res: r } = res();
    await expect(routeSkills("/skills/sync", "POST", req("POST", {}, auth), r, deps(fakeSync({})))).rejects.toMatchObject(
      { status: 401 },
    );
  });

  it("rejects wrong methods with 405 and search with 501", async () => {
    await expect(routeSkills("/skills/sync", "GET", req("GET"), res().res, deps(null))).rejects.toMatchObject({
      status: 405,
    });
    await expect(routeSkills("/skills/search", "GET", req("GET"), res().res, deps(null))).rejects.toBeInstanceOf(
      HttpError,
    );
  });
});

describe("POST /skills/sync", () => {
  it("200 applied once a run reaches the requested generation", async () => {
    let asked: unknown[] = [];
    const sync = fakeSync({
      syncForNudge: async (...args: unknown[]) => {
        asked = args;
        return { kind: "applied", appliedGeneration: 4, results: [{ slug: "a", status: "installed" }] };
      },
    });
    const { res: r, out } = res();
    await routeSkills("/skills/sync", "POST", req("POST", { generation: 4 }), r, deps(sync));
    expect(asked).toEqual([4, 1_000]);
    expect(out.status).toBe(200);
    expect(out.json()).toEqual({
      status: "applied",
      applied_generation: 4,
      results: [{ slug: "a", status: "installed" }],
    });
  });

  it("202 in_progress while the reconcile is still running (or will retry)", async () => {
    const sync = fakeSync({ syncForNudge: async () => ({ kind: "in_progress", generation: 5 }) });
    const { res: r, out } = res();
    await routeSkills("/skills/sync", "POST", req("POST", { generation: 5 }), r, deps(sync));
    expect(out.status).toBe(202);
    expect(out.json()).toEqual({ status: "in_progress", generation: 5 });
  });

  it("409 legacy for a console without the library, or a vessel without the platform MCP", async () => {
    const legacy = fakeSync({ mode: "legacy", syncForNudge: async () => ({ kind: "legacy" }) });
    const a = res();
    await routeSkills("/skills/sync", "POST", req("POST", {}), a.res, deps(legacy));
    expect(a.out.status).toBe(409);
    expect(a.out.json()).toEqual({ status: "legacy" });

    const b = res();
    await routeSkills("/skills/sync", "POST", req("POST"), b.res, deps(null));
    expect(b.out.status).toBe(409);
    expect((b.out.json() as { status: string }).status).toBe("legacy");
  });

  it("400 on a malformed generation", async () => {
    await expect(
      routeSkills("/skills/sync", "POST", req("POST", { generation: "7" }), res().res, deps(fakeSync({}))),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      routeSkills("/skills/sync", "POST", req("POST", { generation: -1 }), res().res, deps(fakeSync({}))),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("GET /skills", () => {
  it("serves the lock in library mode (keeping slug/version/source for the old UI)", async () => {
    const status = {
      mode: "library",
      generation: 3,
      lock_digest: "d",
      skills: [{ slug: "a", version: "1.0.0", content_sha256: "c", managed_by: "operator", source: "library" }],
    };
    const { res: r, out } = res();
    await routeSkills("/skills", "GET", req("GET"), r, deps(fakeSync({ status: async () => status })));
    expect(out.status).toBe(200);
    expect(out.json()).toEqual(status);
  });

  it("lists the folders in legacy mode", async () => {
    await mkdir(join(stateDir, "workspace", "skills", "web-search"), { recursive: true });
    await mkdir(join(stateDir, "workspace", "skills", ".clawhub"), { recursive: true });
    const { res: r, out } = res();
    await routeSkills("/skills", "GET", req("GET"), r, deps(fakeSync({ mode: "legacy" })));
    expect(out.json()).toEqual({
      mode: "legacy",
      generation: null,
      lock_digest: null,
      skills: [{ slug: "web-search", version: null, source: "clawhub" }],
    });
  });
});

describe("deprecated /skills/install and DELETE /skills/:slug (no gateway restart)", () => {
  // The handlers are never given the gateway process: a change reaches the
  // running agent only through the skills.entries rev bump asserted below.
  it("install: ClawHub install → deps → fresh rev bump", async () => {
    const { res: r, out } = res();
    await routeSkills(
      "/skills/install",
      "POST",
      req("POST", { slug: "web-search", version: "0.2.0" }),
      r,
      deps(fakeSync({ mode: "legacy" })),
    );
    expect(out.status).toBe(200);
    expect(out.json()).toEqual({ ok: true, skill: { slug: "web-search", version: "0.2.0", source: "clawhub" } });
    expect(installs).toEqual([{ source: "clawhub", ref: "web-search", version: "0.2.0" }]);
    expect(depsCalls).toHaveLength(1);
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toEqual([{ key: "web-search", rev: expect.stringMatching(/^[0-9a-f]{12}$/) }]);
  });

  it("works without the platform MCP too", async () => {
    const { out, res: r } = res();
    await routeSkills("/skills/install", "POST", req("POST", { slug: "x" }), r, deps(null));
    expect(out.status).toBe(200);
    expect(refreshes).toHaveLength(1);
  });

  it("remove: deletes the folder and bumps a removal", async () => {
    const dir = join(stateDir, "workspace", "skills", "web-search");
    await mkdir(dir, { recursive: true });
    const { res: r, out } = res();
    await routeSkills("/skills/web-search", "DELETE", req("DELETE"), r, deps(fakeSync({ mode: "legacy" })));
    expect(out.status).toBe(200);
    await expect(stat(dir)).rejects.toThrow();
    expect(refreshes).toEqual([[{ key: "web-search", remove: true }]]);
  });

  it("are refused (409) once SkillSync owns workspace/skills (library mode)", async () => {
    const a = res();
    await routeSkills("/skills/install", "POST", req("POST", { slug: "x" }), a.res, deps(fakeSync({})));
    expect(a.out.status).toBe(409);
    const b = res();
    await routeSkills("/skills/x", "DELETE", req("DELETE"), b.res, deps(fakeSync({})));
    expect(b.out.status).toBe(409);
    expect(installs).toEqual([]);
    expect(refreshes).toEqual([]);
  });

  it("still guards traversal", async () => {
    await expect(
      routeSkills("/skills/..%2F..%2Fetc", "DELETE", req("DELETE"), res().res, deps(null)),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      routeSkills("/skills/install", "POST", req("POST", { slug: "../../etc" }), res().res, deps(null)),
    ).rejects.toMatchObject({ status: 400 });
  });
});
