import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SkillRequirement } from "../bundle/types.js";
import {
  EMPTY_REQUIREMENTS,
  manifestDigest,
  sha256Hex,
  type SyncPlanLegacySkill,
  type SyncPlanRequest,
  type SyncPlanSkill,
  type SyncReport,
} from "./contract.js";
import type { DepsRunner } from "./deps.js";
import type { SkillEligibility } from "./eligibility.js";
import { BlobCache, blobCacheDir, type FetchLike } from "./fetch.js";
import { readLock, revFor, writeLock } from "./lock.js";
import type { PlanFetchResult, SkillSyncPlatform } from "./plan.js";
import { RefreshGate, type RevChange } from "./refresh.js";
import type { InstalledSkill } from "./resolver.js";
import { SkillSync, type LegacyInstaller } from "./sync.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Serves blob bodies by sha256 at https://blobs.test/<sha>. */
class BlobServer {
  readonly bodies = new Map<string, string>();
  readonly fail = new Set<string>();
  readonly hits: string[] = [];
  fetch: FetchLike = async (url) => {
    const sha = url.split("/").pop()!;
    this.hits.push(sha);
    if (this.fail.has(sha)) return new Response("boom", { status: 500 });
    const body = this.bodies.get(sha);
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
  };
  add(body: string): string {
    const sha = sha256Hex(body);
    this.bodies.set(sha, body);
    return sha;
  }
}

interface FileSpec {
  path: string;
  body: string;
  exec?: boolean;
}

function skillMd(slug: string, description: string, extra = ""): string {
  return `---\nname: ${slug}\ndescription: ${description}\n${extra}---\n\n# ${slug}\n`;
}

function makeVersion(
  server: BlobServer,
  slug: string,
  specs: FileSpec[],
  extra: Partial<SyncPlanSkill> = {},
): SyncPlanSkill {
  const files = specs.map((f) => {
    const sha = server.add(f.body);
    return {
      path: f.path,
      sha256: sha,
      size: Buffer.byteLength(f.body),
      executable: f.exec === true,
      url: `https://blobs.test/${sha}`,
    };
  });
  const content = manifestDigest(files.map(({ url: _url, ...m }) => m));
  return {
    slug,
    skill_id: `skill-${slug}`,
    version_id: `ver-${content.slice(0, 8)}`,
    version: "1.0.0",
    content_sha256: content,
    managed_by: "operator",
    required: false,
    skill_key: null,
    requirements: { ...EMPTY_REQUIREMENTS },
    files,
    ...extra,
  };
}

/** A console that serves get_skill_sync_plan like the real one: files only for
 *  skills whose installed digest differs; `unchanged` on a matching generation. */
class FakePlatform implements SkillSyncPlatform {
  generation = 1;
  skills: SyncPlanSkill[] = [];
  legacy: SyncPlanLegacySkill[] = [];
  mode: "ok" | "legacy" | "down" = "ok";
  gate: Promise<void> | null = null;
  readonly requests: SyncPlanRequest[] = [];
  readonly reports: SyncReport[] = [];

  async getSkillSyncPlan(req: SyncPlanRequest): Promise<PlanFetchResult> {
    this.requests.push(structuredClone(req));
    if (this.gate) await this.gate;
    if (this.mode === "legacy") return { kind: "legacy", detail: "Unknown tool: get_skill_sync_plan" };
    if (this.mode === "down") throw new Error("platform MCP 503: unavailable");
    if (req.if_generation === this.generation) {
      return { kind: "plan", plan: { generation: this.generation, unchanged: true } };
    }
    const skills = this.skills.map((s) => {
      if (req.installed?.[s.slug] === s.content_sha256) {
        const { files: _files, ...rest } = s;
        return rest;
      }
      return structuredClone(s);
    });
    return {
      kind: "plan",
      plan: { generation: this.generation, skills, ...(this.legacy.length ? { legacy: this.legacy } : {}) },
    };
  }

  async reportSkillSync(report: SyncReport): Promise<void> {
    this.reports.push(structuredClone(report));
  }

  get lastReport(): SyncReport | undefined {
    return this.reports[this.reports.length - 1];
  }
}

function depsRunner(over: Partial<DepsRunner> = {}): DepsRunner & { installs: string[][] } {
  const r = {
    installs: [] as string[][],
    interpreter: async () => ({ python: "/opt/skills-venv/bin/python3", venvId: "venv-1" }),
    install: async (_py: string, reqs: string[]) => {
      r.installs.push(reqs);
      return { ok: true };
    },
    installChromium: async () => ({ ok: true }),
    ...over,
  };
  return r;
}

class FakeLegacyInstaller implements LegacyInstaller {
  readonly calls: SkillRequirement[] = [];
  fail = false;
  async install(req: SkillRequirement, skillsDir: string): Promise<InstalledSkill> {
    this.calls.push(req);
    if (this.fail) throw new Error("clawhub install failed: 502");
    const dir = join(skillsDir, req.ref);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), skillMd(req.ref, `ClawHub ${req.version || "latest"}`));
    return { ref: req.ref, version: req.version, path: dir, source: "clawhub" };
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let stateDir: string;
let server: BlobServer;
let platform: FakePlatform;
let refreshes: RevChange[][];
let eligibility: Map<string, SkillEligibility> | null;
let legacy: FakeLegacyInstaller;
let deps: ReturnType<typeof depsRunner>;
let gate: RefreshGate;

function makeSync(over: { deps?: DepsRunner; settleMs?: number } = {}): SkillSync {
  return new SkillSync({
    stateDir,
    platform,
    blobs: new BlobCache({ dir: blobCacheDir(stateDir), fetch: server.fetch }),
    depsRunner: over.deps ?? deps,
    eligibility: async () => eligibility,
    legacyInstaller: legacy,
    gate,
    refreshSettleMs: over.settleMs ?? 0,
  });
}

/** The gateway is up: open the gate (flushing what boot queued) and forget
 *  that flush so assertions see only live refreshes. */
async function goLive(): Promise<void> {
  await gate.open();
  refreshes.length = 0;
}

const skillsDir = () => join(stateDir, "workspace", "skills");
const live = (slug: string, path = "SKILL.md") => readFile(join(skillsDir(), slug, path), "utf8");
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "knox-sync-"));
  server = new BlobServer();
  platform = new FakePlatform();
  refreshes = [];
  eligibility = null;
  legacy = new FakeLegacyInstaller();
  deps = depsRunner();
  gate = new RefreshGate(async (changes) => {
    refreshes.push(changes);
  });
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const HELLO_V1: FileSpec[] = [
  { path: "SKILL.md", body: skillMd("hello-world", "Say hello.") },
  { path: "scripts/hello.py", body: "#!/usr/bin/env python3\nprint('hi')\n", exec: true },
];
const HELLO_V2: FileSpec[] = [
  { path: "SKILL.md", body: skillMd("hello-world", "Say hello, better.") },
  { path: "scripts/hello.py", body: "#!/usr/bin/env python3\nprint('hi')\n", exec: true },
];

// ---------------------------------------------------------------------------

describe("SkillSync.reconcile — install / update / no-op / remove", () => {
  it("fresh install at boot: files + modes, lock, report — and no live refresh before the gateway runs", async () => {
    const v1 = makeVersion(server, "hello-world", HELLO_V1);
    platform.skills = [v1];
    const sync = makeSync();

    const out = await sync.reconcile("boot");

    expect(out.status).toBe("applied");
    expect(out.appliedGeneration).toBe(1);
    expect(sync.mode).toBe("library");
    expect(platform.requests[0]).toEqual({ installed: {} }); // boot never sends if_generation
    expect(await live("hello-world")).toContain("Say hello.");
    expect((await stat(join(skillsDir(), "hello-world", "scripts/hello.py"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(skillsDir(), "hello-world", "SKILL.md"))).mode & 0o777).toBe(0o644);

    const { lock } = await readLock(stateDir);
    expect(lock.generation).toBe(1);
    expect(lock.skills["hello-world"]).toMatchObject({
      source: "library",
      content_sha256: v1.content_sha256,
      skill_id: "skill-hello-world",
      version_id: v1.version_id,
      managed_by: "operator",
    });
    expect(lock.skills["hello-world"]!.files).toHaveLength(2);

    expect(refreshes).toEqual([]); // the boot config write carries the rev instead
    expect(platform.lastReport).toMatchObject({
      generation: 1,
      results: [{ slug: "hello-world", status: "installed", skill_id: "skill-hello-world" }],
    });
    expect(platform.lastReport?.lock_digest).toBe(sha256Hex(`hello-world@${v1.content_sha256}`));
    // Nothing left in the scratch dirs.
    expect(await readdir(join(stateDir, "workspace", ".skills-staging")).catch(() => [])).toEqual([]);
  });

  it("update: fetches only changed blobs, swaps atomically, bumps the rev on the running gateway", async () => {
    const v1 = makeVersion(server, "hello-world", HELLO_V1);
    platform.skills = [v1];
    const sync = makeSync();
    await sync.reconcile("boot");
    await goLive();
    const hitsAfterBoot = server.hits.length;

    const v2 = makeVersion(server, "hello-world", HELLO_V2, { version: "1.1.0" });
    platform.skills = [v2];
    platform.generation = 2;
    const out = await sync.reconcile("nudge");

    expect(platform.requests[1]).toEqual({
      if_generation: 1,
      installed: { "hello-world": v1.content_sha256 },
    });
    expect(out).toMatchObject({ status: "applied", appliedGeneration: 2, changed: ["hello-world"] });
    expect(await live("hello-world")).toContain("Say hello, better.");
    // The script body was unchanged → served from the cache; only SKILL.md fetched.
    expect(server.hits.slice(hitsAfterBoot)).toEqual([sha256Hex(HELLO_V2[0]!.body)]);
    expect(refreshes).toEqual([[{ key: "hello-world", rev: revFor(v2.content_sha256) }]]);
    expect((await readLock(stateDir)).lock.skills["hello-world"]?.version).toBe("1.1.0");
  });

  it("no-op: a poll at the applied generation is one cheap call — no writes, refresh or report", async () => {
    platform.skills = [makeVersion(server, "hello-world", HELLO_V1)];
    const sync = makeSync();
    await sync.reconcile("boot");
    await goLive();
    const reports = platform.reports.length;
    const hits = server.hits.length;

    const out = await sync.reconcile("poll");

    expect(out.status).toBe("unchanged");
    expect(out.results).toEqual([expect.objectContaining({ slug: "hello-world", status: "installed" })]);
    expect(platform.requests[1]?.if_generation).toBe(1);
    expect(platform.reports.length).toBe(reports);
    expect(server.hits.length).toBe(hits);
    expect(refreshes).toEqual([]);
  });

  it("a new generation with the same content changes nothing on disk", async () => {
    platform.skills = [makeVersion(server, "hello-world", HELLO_V1)];
    const sync = makeSync();
    await sync.reconcile("boot");
    await goLive();
    platform.generation = 5;
    platform.skills = [{ ...platform.skills[0]!, managed_by: "capability", required: true }];

    const out = await sync.reconcile("nudge");

    expect(out).toMatchObject({ status: "applied", appliedGeneration: 5, changed: [] });
    expect(refreshes).toEqual([]);
    expect((await readLock(stateDir)).lock.skills["hello-world"]).toMatchObject({
      managed_by: "capability",
      required: true,
    });
  });

  it("removal: a skill the plan dropped is taken out, unlocked, rev entry removed, reported", async () => {
    const v1 = makeVersion(server, "hello-world", HELLO_V1);
    platform.skills = [v1];
    const sync = makeSync();
    await sync.reconcile("boot");
    await goLive();

    platform.skills = [];
    platform.generation = 2;
    const out = await sync.reconcile("nudge");

    expect(await exists(join(skillsDir(), "hello-world"))).toBe(false);
    expect((await readLock(stateDir)).lock.skills).toEqual({});
    expect(refreshes).toEqual([[{ key: "hello-world", remove: true }]]);
    expect(out.results).toEqual([
      { slug: "hello-world", skill_id: "skill-hello-world", version_id: v1.version_id, status: "removed" },
    ]);
  });

  it("uses metadata.openclaw.skillKey as the openclaw.json entry key", async () => {
    platform.skills = [
      makeVersion(server, "keyed", [
        { path: "SKILL.md", body: skillMd("keyed", "K.", "metadata:\n  openclaw:\n    skillKey: custom-key\n") },
      ]),
    ];
    const sync = makeSync();
    await goLive();
    await sync.reconcile("nudge");
    expect(refreshes[0]).toEqual([{ key: "custom-key", rev: revFor(platform.skills[0]!.content_sha256) }]);
    expect((await readLock(stateDir)).lock.skills.keyed?.skill_key).toBe("custom-key");
  });
});

describe("SkillSync.reconcile — unmanaged folders", () => {
  it("quarantines folders no plan put there (kept, reported) once SkillSync owns skills/", async () => {
    platform.skills = [makeVersion(server, "hello-world", HELLO_V1)];
    const sync = makeSync();
    await sync.reconcile("boot");
    await goLive();

    await mkdir(join(skillsDir(), "handmade"), { recursive: true });
    await writeFile(join(skillsDir(), "handmade", "SKILL.md"), skillMd("handmade", "Mine."));
    platform.generation = 2;
    const out = await sync.reconcile("nudge");

    expect(out.unmanaged).toEqual(["handmade"]);
    expect(platform.lastReport?.unmanaged).toEqual(["handmade"]);
    expect(await exists(join(skillsDir(), "handmade"))).toBe(false);
    const parked = await readdir(join(stateDir, "workspace", ".skills-unmanaged"));
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatch(/^handmade-/);
    expect(refreshes).toEqual([[{ key: "handmade", remove: true }]]);
  });

  it("first library boot: an old same-slug folder is replaced; anything else is quarantined", async () => {
    await mkdir(join(skillsDir(), "hello-world"), { recursive: true });
    await writeFile(join(skillsDir(), "hello-world", "SKILL.md"), "old clawhub copy");
    await mkdir(join(skillsDir(), "stray"), { recursive: true });
    await writeFile(join(skillsDir(), "stray", "SKILL.md"), skillMd("stray", "Leftover."));
    platform.skills = [makeVersion(server, "hello-world", HELLO_V1)];

    const out = await makeSync().reconcile("boot");

    expect(await live("hello-world")).toContain("Say hello.");
    expect(out.unmanaged).toEqual(["stray"]);
    const parked = await readdir(join(stateDir, "workspace", ".skills-unmanaged"));
    expect(parked.map((p) => p.split("-")[0])).toEqual(["stray"]); // the old hello-world copy is gone, not parked
  });

  it("after the first run, a hand-written folder in the way of a new library skill is preserved", async () => {
    await writeLock(stateDir, { version: 1, generation: 1, skills: {} });
    await mkdir(join(skillsDir(), "hello-world"), { recursive: true });
    await writeFile(join(skillsDir(), "hello-world", "SKILL.md"), "agent draft");
    platform.skills = [makeVersion(server, "hello-world", HELLO_V1)];
    platform.generation = 2;

    const out = await makeSync().reconcile("nudge");

    expect(await live("hello-world")).toContain("Say hello.");
    expect(out.unmanaged).toEqual(["hello-world"]);
    const [parked] = await readdir(join(stateDir, "workspace", ".skills-unmanaged"));
    expect(await readFile(join(stateDir, "workspace", ".skills-unmanaged", parked!, "SKILL.md"), "utf8")).toBe(
      "agent draft",
    );
  });
});

describe("SkillSync.reconcile — failures", () => {
  it("deps failure: the new version is not activated, the old one stays live, reported failed", async () => {
    platform.skills = [makeVersion(server, "hello-world", HELLO_V1)];
    const failingDeps = depsRunner({
      install: async () => ({ ok: false, error: "exit 1: × No solution found when resolving dependencies" }),
    });
    const sync = makeSync({ deps: failingDeps });
    await sync.reconcile("boot");
    await goLive();

    platform.skills = [
      makeVersion(server, "hello-world", [
        {
          path: "SKILL.md",
          body: skillMd("hello-world", "Needs deps.", "metadata:\n  openclaw:\n    install:\n      uv: [nope==0.0]\n"),
        },
      ]),
    ];
    platform.generation = 2;
    const out = await sync.reconcile("nudge");

    expect(await live("hello-world")).toContain("Say hello."); // v1 still live
    expect(await exists(join(skillsDir(), "hello-world", "scripts/hello.py"))).toBe(true);
    expect((await readLock(stateDir)).lock.skills["hello-world"]?.content_sha256).not.toBe(
      platform.skills[0]!.content_sha256,
    );
    const r = out.results.find((x) => x.slug === "hello-world");
    expect(r?.status).toBe("failed");
    expect(r?.detail?.error).toContain("No solution found");
    expect(refreshes).toEqual([]);
    // A deps failure is definitive for this generation (not retried every poll).
    expect(out.appliedGeneration).toBe(2);
  });

  it("deps that failed for a live skill are retried on the next applied run", async () => {
    const DEPS_MD = skillMd("hello-world", "D.", "metadata:\n  openclaw:\n    install:\n      uv: [mcp>=1.9.0]\n");
    platform.skills = [makeVersion(server, "hello-world", [{ path: "SKILL.md", body: DEPS_MD }])];
    await makeSync().reconcile("boot");

    // New container (fresh venv) and PyPI is down: the skill stays active, reported failed.
    let pypiUp = false;
    const flaky = depsRunner({
      interpreter: async () => ({ python: "/p", venvId: "venv-2" }),
      install: async () => (pypiUp ? { ok: true } : { ok: false, error: "exit 2: connection reset" }),
    });
    const sync = makeSync({ deps: flaky });
    const boot = await sync.reconcile("boot");
    expect(boot.results[0]).toMatchObject({ slug: "hello-world", status: "failed" });
    expect(boot.results[0]?.detail?.error).toContain("skill left active");
    expect(await live("hello-world")).toContain("D.");

    pypiUp = true;
    platform.generation = 2;
    const next = await sync.reconcile("nudge");
    expect(next.results[0]).toMatchObject({ slug: "hello-world", status: "installed" });
    expect((await readLock(stateDir)).lock.skills["hello-world"]?.deps_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("transient download failure: old version stays, generation NOT advanced, next poll retries and converges", async () => {
    platform.skills = [makeVersion(server, "hello-world", HELLO_V1)];
    const sync = makeSync();
    await sync.reconcile("boot");
    await goLive();

    const v2 = makeVersion(server, "hello-world", HELLO_V2);
    platform.skills = [v2];
    platform.generation = 2;
    server.fail.add(sha256Hex(HELLO_V2[0]!.body));
    const first = await sync.reconcile("nudge");

    expect(first.retryPending).toBe(true);
    expect(first.appliedGeneration).toBe(1);
    expect(first.results[0]).toMatchObject({ slug: "hello-world", status: "failed" });
    expect(first.results[0]?.detail?.error).toMatch(/will retry/);
    expect(await live("hello-world")).toContain("Say hello.");
    expect((await readLock(stateDir)).lock.generation).toBe(1);

    server.fail.clear();
    const second = await sync.reconcile("poll");
    expect(platform.requests[2]?.if_generation).toBe(1); // still behind → full plan
    expect(second).toMatchObject({ status: "applied", appliedGeneration: 2, retryPending: false });
    expect(await live("hello-world")).toContain("better");
  });

  it("refuses unsafe manifests and digest mismatches, definitively", async () => {
    const evil = makeVersion(server, "evil", [
      { path: "SKILL.md", body: skillMd("evil", "E.") },
      { path: "../escape.sh", body: "rm -rf /" },
    ]);
    const lying = { ...makeVersion(server, "liar", [{ path: "SKILL.md", body: skillMd("liar", "L.") }]) };
    lying.content_sha256 = sha256Hex("something else");
    const misnamed = makeVersion(server, "misnamed", [{ path: "SKILL.md", body: skillMd("other-name", "M.") }]);
    platform.skills = [evil, lying, misnamed];

    const out = await makeSync().reconcile("boot");

    const byslug = Object.fromEntries(out.results.map((r) => [r.slug, r]));
    expect(byslug.evil?.status).toBe("failed");
    expect(byslug.evil?.detail?.error).toMatch(/not an allowed path/);
    expect(byslug.liar?.detail?.error).toMatch(/digest/);
    expect(byslug.misnamed?.detail?.error).toMatch(/does not match the slug/);
    expect(out.appliedGeneration).toBe(1); // definitive: no retry storm
    expect(await exists(join(stateDir, "workspace", "escape.sh"))).toBe(false);
    expect(await readdir(skillsDir()).catch(() => [])).toEqual([]);
  });

  it("boot re-hashes installed skills: a hand-edited or half-swapped folder is reinstalled", async () => {
    const v1 = makeVersion(server, "hello-world", HELLO_V1);
    platform.skills = [v1];
    await makeSync().reconcile("boot");
    await writeFile(join(skillsDir(), "hello-world", "SKILL.md"), "tampered");

    await makeSync().reconcile("boot");

    expect(platform.requests[1]?.installed).toEqual({}); // didn't claim the damaged copy
    expect(await live("hello-world")).toContain("Say hello.");
  });

  it("a missing folder at runtime is reinstalled (no if_generation short-circuit)", async () => {
    platform.skills = [makeVersion(server, "hello-world", HELLO_V1)];
    const sync = makeSync();
    await sync.reconcile("boot");
    await rm(join(skillsDir(), "hello-world"), { recursive: true });

    await sync.reconcile("poll");

    expect(platform.requests[1]?.if_generation).toBeUndefined();
    expect(await live("hello-world")).toContain("Say hello.");
  });
});

describe("SkillSync.reconcile — modes", () => {
  it("an older console (Unknown tool) → legacy mode, nothing touched", async () => {
    platform.mode = "legacy";
    await mkdir(join(skillsDir(), "clawhub-skill"), { recursive: true });
    const sync = makeSync();

    const out = await sync.reconcile("boot");

    expect(out.status).toBe("legacy");
    expect(sync.mode).toBe("legacy");
    expect(await exists(join(skillsDir(), "clawhub-skill"))).toBe(true);
    expect(platform.reports).toEqual([]);
  });

  it("a console that starts serving the library is picked up by the next nudge", async () => {
    platform.mode = "legacy";
    const sync = makeSync();
    await sync.reconcile("boot");
    platform.mode = "ok";
    platform.skills = [makeVersion(server, "hello-world", HELLO_V1)];

    const out = await sync.reconcile("nudge");

    expect(out.status).toBe("applied");
    expect(sync.mode).toBe("library");
    expect(await live("hello-world")).toContain("Say hello.");
  });

  it("plan fetch failure at boot keeps the last-known-good set and still provisions deps", async () => {
    platform.skills = [
      makeVersion(server, "hello-world", [
        {
          path: "SKILL.md",
          body: skillMd("hello-world", "D.", "metadata:\n  openclaw:\n    install:\n      uv: [mcp>=1.9.0]\n"),
        },
      ]),
    ];
    await makeSync().reconcile("boot");
    expect(deps.installs).toEqual([["mcp>=1.9.0"]]);

    // New container: fresh venv identity, platform down.
    platform.mode = "down";
    const freshVenv = depsRunner({ interpreter: async () => ({ python: "/p", venvId: "venv-2" }) });
    const sync = makeSync({ deps: freshVenv });
    const out = await sync.reconcile("boot");

    expect(out.status).toBe("error");
    expect(sync.mode).toBe("library");
    expect(await live("hello-world")).toContain("D.");
    expect(freshVenv.installs).toEqual([["mcp>=1.9.0"]]);
    expect(await sync.missingRequiredSkills(["hello-world", "skill-hello-world", "ghost"])).toEqual(["ghost"]);
  });

  it("legacy (ClawHub) capability refs: installed once, locked as clawhub, removed when dropped", async () => {
    platform.legacy = [{ slug: "old-tool", version: "1.2.0", required: true }];
    const sync = makeSync();
    await goLive();

    const first = await sync.reconcile("nudge");
    expect(first.results).toEqual([{ slug: "old-tool", status: "installed" }]);
    expect(legacy.calls).toEqual([{ source: "clawhub", ref: "old-tool", version: "1.2.0" }]);
    expect((await readLock(stateDir)).lock.skills["old-tool"]).toMatchObject({
      source: "clawhub",
      content_sha256: "clawhub:1.2.0",
      required: true,
    });
    expect(refreshes[0]).toEqual([{ key: "old-tool", rev: revFor("clawhub:1.2.0") }]);

    platform.generation = 2;
    await sync.reconcile("nudge");
    expect(legacy.calls).toHaveLength(1); // already at that version

    platform.legacy = [];
    platform.generation = 3;
    const gone = await sync.reconcile("nudge");
    expect(gone.results).toEqual([{ slug: "old-tool", status: "removed" }]);
    expect(await exists(join(skillsDir(), "old-tool"))).toBe(false);
  });
});

describe("SkillSync — eligibility, coalescing, nudges", () => {
  it("maps missing env/bins from `openclaw skills check` to `ineligible`", async () => {
    platform.skills = [makeVersion(server, "hello-world", HELLO_V1)];
    eligibility = new Map([
      [
        "hello-world",
        { eligible: false, missing_env: ["HELLO_TOKEN"], missing_bins: ["jq"], missing_config: [], missing_os: [] },
      ],
    ]);
    const out = await makeSync().reconcile("boot");
    expect(out.results).toEqual([
      expect.objectContaining({
        slug: "hello-world",
        status: "ineligible",
        detail: { missing_env: ["HELLO_TOKEN"], missing_bins: ["jq"] },
      }),
    ]);
    // Files stay live: OpenClaw hides it until the credential is bound.
    expect(await live("hello-world")).toContain("Say hello.");
  });

  it("changes made before the gateway watches are queued, then flushed when the gate opens", async () => {
    const v1 = makeVersion(server, "hello-world", HELLO_V1);
    platform.skills = [v1];
    const sync = makeSync();
    await sync.reconcile("boot");
    platform.skills = [];
    platform.generation = 2;
    await sync.reconcile("nudge"); // e.g. a nudge while the gateway is still starting
    expect(refreshes).toEqual([]);

    await gate.open();
    expect(refreshes).toEqual([
      [
        { key: "hello-world", rev: revFor(v1.content_sha256) },
        { key: "hello-world", remove: true },
      ],
    ]);
  });

  it("a live refresh settles before the run completes (so `applied` means the next turn sees it)", async () => {
    platform.skills = [makeVersion(server, "hello-world", HELLO_V1)];
    const sync = makeSync({ settleMs: 120 });
    await goLive();
    const t0 = Date.now();
    await sync.reconcile("nudge");
    expect(refreshes).toHaveLength(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
  });

  it("is single-flight: triggers during a run coalesce into exactly one rerun", async () => {
    platform.skills = [makeVersion(server, "hello-world", HELLO_V1)];
    let release!: () => void;
    platform.gate = new Promise((r) => {
      release = r;
    });
    const sync = makeSync();
    const a = sync.reconcile("boot");
    const b = sync.reconcile("poll");
    const c = sync.reconcile("nudge");
    expect(b).toBe(c); // one shared rerun
    release();
    platform.gate = null;
    await Promise.all([a, b, c]);
    expect(platform.requests).toHaveLength(2);
    expect(sync.busy).toBe(false);
  });

  it("syncForNudge: applied once a run reaches the requested generation", async () => {
    platform.skills = [makeVersion(server, "hello-world", HELLO_V1)];
    platform.generation = 3;
    const out = await makeSync().syncForNudge(3, 5_000);
    expect(out).toMatchObject({ kind: "applied", appliedGeneration: 3 });
  });

  it("syncForNudge: in_progress when the wait runs out (e.g. a long deps install)", async () => {
    platform.gate = new Promise(() => {}); // never resolves
    const out = await makeSync().syncForNudge(1, 50);
    expect(out).toEqual({ kind: "in_progress", generation: 1 });
  });

  it("syncForNudge: in_progress when the plan is still behind the requested generation", async () => {
    platform.generation = 2;
    const out = await makeSync().syncForNudge(9, 5_000);
    expect(out).toEqual({ kind: "in_progress", generation: 9 });
  });

  it("syncForNudge: legacy console → legacy", async () => {
    platform.mode = "legacy";
    expect(await makeSync().syncForNudge(1, 5_000)).toEqual({ kind: "legacy" });
  });

  it("status() reports the lock for GET /skills", async () => {
    const v1 = makeVersion(server, "hello-world", HELLO_V1);
    platform.skills = [v1];
    const sync = makeSync();
    await sync.reconcile("boot");
    expect(await sync.status()).toEqual({
      mode: "library",
      generation: 1,
      lock_digest: sha256Hex(`hello-world@${v1.content_sha256}`),
      skills: [
        {
          slug: "hello-world",
          version: "1.0.0",
          content_sha256: v1.content_sha256,
          managed_by: "operator",
          source: "library",
          required: false,
          status: "installed",
        },
      ],
    });
  });
});
