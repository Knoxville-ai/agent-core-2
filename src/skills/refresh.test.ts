import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyRevChanges,
  bumpSkillRevs,
  freshRev,
  isRevOnlyEntry,
  REFRESH_SENTINEL_KEY,
  RefreshGate,
  type RevChange,
} from "./refresh.js";

function baseConfig(): Record<string, unknown> {
  return {
    agents: { defaults: { workspace: "/ws" } },
    gateway: { port: 18789, reload: { mode: "hot" } },
    skills: {
      allowBundled: ["skill-creator"],
      entries: {
        alpha: { config: { rev: "aaaaaaaaaaaa" } },
        // An entry someone else configured: never deleted, only our rev changes.
        mixed: { env: { TOKEN: "x" }, config: { rev: "bbbbbbbbbbbb", other: 1 } },
        foreign: { enabled: true },
      },
    },
    channels: {},
  };
}

describe("applyRevChanges", () => {
  it("sets a rev, creating the entry when needed, and preserves every other key", () => {
    const cfg = baseConfig();
    const changed = applyRevChanges(cfg, [
      { key: "alpha", rev: "111111111111" },
      { key: "newbie", rev: "222222222222" },
      { key: "mixed", rev: "333333333333" },
    ]);
    expect(changed).toBe(true);
    const skills = cfg.skills as { allowBundled: string[]; entries: Record<string, unknown> };
    expect(skills.allowBundled).toEqual(["skill-creator"]);
    expect(skills.entries.alpha).toEqual({ config: { rev: "111111111111" } });
    expect(skills.entries.newbie).toEqual({ config: { rev: "222222222222" } });
    expect(skills.entries.mixed).toEqual({ env: { TOKEN: "x" }, config: { rev: "333333333333", other: 1 } });
    expect(skills.entries.foreign).toEqual({ enabled: true });
    expect(cfg.gateway).toEqual({ port: 18789, reload: { mode: "hot" } });
    expect(cfg.agents).toEqual({ defaults: { workspace: "/ws" } });
  });

  it("deletes an entry on removal only when it holds nothing but our rev", () => {
    const cfg = baseConfig();
    applyRevChanges(cfg, [
      { key: "alpha", remove: true },
      { key: "mixed", remove: true },
    ]);
    const entries = (cfg.skills as { entries: Record<string, unknown> }).entries;
    expect(entries.alpha).toBeUndefined();
    // Mixed entry survives; only our rev is dropped.
    expect(entries.mixed).toEqual({ env: { TOKEN: "x" }, config: { other: 1 } });
    expect(entries.foreign).toEqual({ enabled: true });
  });

  it("a removal with nothing of ours to drop changes nothing by itself…", () => {
    const cfg = baseConfig();
    expect(applyRevChanges(cfg, [{ key: "foreign", remove: true }, { key: "ghost", remove: true }])).toBe(false);
    expect(cfg).toEqual(baseConfig());
  });

  it("…but with ensureChange the sentinel entry is bumped so sessions still rebuild", () => {
    const cfg = baseConfig();
    expect(applyRevChanges(cfg, [{ key: "ghost", remove: true }], { ensureChange: true })).toBe(true);
    const entries = (cfg.skills as { entries: Record<string, unknown> }).entries;
    expect(entries[REFRESH_SENTINEL_KEY]).toEqual({ config: { rev: expect.stringMatching(/^[0-9a-f]{12}$/) } });
    expect(entries.foreign).toEqual({ enabled: true }); // never touched
    expect(entries.ghost).toBeUndefined(); // no garbage entry for the removed key
  });

  it("ensureChange adds nothing when the changes already changed something", () => {
    const cfg = baseConfig();
    applyRevChanges(cfg, [{ key: "alpha", rev: "999999999999" }], { ensureChange: true });
    expect((cfg.skills as { entries: Record<string, unknown> }).entries[REFRESH_SENTINEL_KEY]).toBeUndefined();
  });

  it("reports no change when the rev is already current", () => {
    const cfg = baseConfig();
    expect(applyRevChanges(cfg, [{ key: "alpha", rev: "aaaaaaaaaaaa" }])).toBe(false);
  });

  it("creates the skills block on a config that has none", () => {
    const cfg: Record<string, unknown> = { gateway: {} };
    expect(applyRevChanges(cfg, [{ key: "a", rev: "abcabcabcabc" }])).toBe(true);
    expect(cfg.skills).toEqual({ entries: { a: { config: { rev: "abcabcabcabc" } } } });
  });

  it("isRevOnlyEntry recognizes exactly { config: { rev } }", () => {
    expect(isRevOnlyEntry({ config: { rev: "x" } })).toBe(true);
    expect(isRevOnlyEntry({ config: { rev: "x", y: 1 } })).toBe(false);
    expect(isRevOnlyEntry({ config: { rev: "x" }, enabled: true })).toBe(false);
    expect(isRevOnlyEntry(null)).toBe(false);
  });

  it("freshRev is 12 hex chars and varies", () => {
    expect(freshRev()).toMatch(/^[0-9a-f]{12}$/);
    expect(freshRev()).not.toBe(freshRev());
  });
});

describe("bumpSkillRevs (openclaw.json on disk)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "knox-refresh-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rewrites the file atomically with the boot writer's formatting", async () => {
    const path = join(dir, "openclaw.json");
    await writeFile(path, JSON.stringify(baseConfig(), null, 2));
    const r = await bumpSkillRevs(dir, [{ key: "beta", rev: "999999999999" }]);
    expect(r.changed).toBe(true);
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text);
    expect(parsed.skills.entries.beta).toEqual({ config: { rev: "999999999999" } });
    expect(parsed.skills.entries.mixed.env).toEqual({ TOKEN: "x" });
    expect(text).toBe(JSON.stringify(parsed, null, 2));
    expect(await readdir(dir)).toEqual(["openclaw.json"]);
  });

  it("leaves the file byte-identical when nothing changes and no change is required", async () => {
    const path = join(dir, "openclaw.json");
    const original = JSON.stringify(baseConfig(), null, 2) + "\n";
    await writeFile(path, original);
    const r = await bumpSkillRevs(dir, [{ key: "alpha", rev: "aaaaaaaaaaaa" }], { ensureChange: false });
    expect(r.changed).toBe(false);
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await bumpSkillRevs(dir, [])).changed).toBe(false);
  });

  it("by default a requested refresh always changes a skills.* path", async () => {
    await writeFile(join(dir, "openclaw.json"), JSON.stringify(baseConfig(), null, 2));
    expect((await bumpSkillRevs(dir, [{ key: "ghost", remove: true }])).changed).toBe(true);
    const parsed = JSON.parse(await readFile(join(dir, "openclaw.json"), "utf8"));
    expect(parsed.skills.entries[REFRESH_SENTINEL_KEY].config.rev).toMatch(/^[0-9a-f]{12}$/);
  });

  it("serializes concurrent bumps without losing either", async () => {
    await writeFile(join(dir, "openclaw.json"), JSON.stringify(baseConfig(), null, 2));
    await Promise.all([
      bumpSkillRevs(dir, [{ key: "one", rev: "111111111111" }]),
      bumpSkillRevs(dir, [{ key: "two", rev: "222222222222" }]),
    ]);
    const parsed = JSON.parse(await readFile(join(dir, "openclaw.json"), "utf8"));
    expect(Object.keys(parsed.skills.entries)).toEqual(expect.arrayContaining(["one", "two"]));
  });
});

describe("RefreshGate", () => {
  function recordingGate(): { gate: RefreshGate; writes: RevChange[][] } {
    const writes: RevChange[][] = [];
    return {
      writes,
      gate: new RefreshGate(async (changes) => {
        writes.push(changes);
      }),
    };
  }

  it("queues changes until the gateway is watching, then flushes them as one write", async () => {
    const { gate, writes } = recordingGate();
    expect(await gate.push([{ key: "a", rev: "111111111111" }])).toEqual({ live: false });
    expect(await gate.push([{ key: "b", remove: true }])).toEqual({ live: false });
    expect(writes).toEqual([]);

    expect(await gate.open()).toBe(true);
    expect(writes).toEqual([[{ key: "a", rev: "111111111111" }, { key: "b", remove: true }]]);
    expect(gate.isOpen).toBe(true);
  });

  it("writes immediately once open", async () => {
    const { gate, writes } = recordingGate();
    await gate.open();
    expect(await gate.push([{ key: "a", rev: "222222222222" }])).toEqual({ live: true });
    expect(writes).toEqual([[{ key: "a", rev: "222222222222" }]]);
  });

  it("open() with nothing queued writes nothing — unless forced (post-restart refresh)", async () => {
    const quiet = recordingGate();
    expect(await quiet.gate.open()).toBe(false);
    expect(quiet.writes).toEqual([]);

    const forced = recordingGate();
    expect(await forced.gate.open({ force: true })).toBe(true);
    expect(forced.writes).toEqual([[{ key: REFRESH_SENTINEL_KEY, rev: expect.stringMatching(/^[0-9a-f]{12}$/) }]]);
  });
});
