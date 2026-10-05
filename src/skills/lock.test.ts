import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256Hex } from "./contract.js";
import {
  LOCK_FILE,
  clearLock,
  emptyLock,
  lockDigest,
  lockSkillEntries,
  parseLock,
  readLock,
  revFor,
  serializeLock,
  writeLock,
  type LockedSkill,
  type SkillLock,
} from "./lock.js";

const SHA_A = sha256Hex("a");
const SHA_B = sha256Hex("b");

function entry(over: Partial<LockedSkill> = {}): LockedSkill {
  return {
    skill_id: "s1",
    version_id: "v1",
    version: "1.0.0",
    content_sha256: SHA_A,
    skill_key: null,
    managed_by: "operator",
    required: false,
    source: "library",
    deps_hash: null,
    installed_at: "2026-10-04T00:00:00.000Z",
    files: [{ path: "SKILL.md", sha256: SHA_A, size: 1, executable: false }],
    ...over,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "knox-lock-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("lock file I/O", () => {
  it("reads an absent lock as empty, existed=false", async () => {
    expect(await readLock(dir)).toEqual({ lock: emptyLock(), existed: false });
  });

  it("round-trips through write/read and leaves no temp files behind", async () => {
    const lock: SkillLock = { version: 1, generation: 7, skills: { alpha: entry() } };
    await writeLock(dir, lock);
    expect(await readLock(dir)).toEqual({ lock, existed: true });
    expect(await readdir(dir)).toEqual([LOCK_FILE]);
  });

  it("treats a corrupt lock as empty (and not as an existing one)", async () => {
    await writeFile(join(dir, LOCK_FILE), "{not json");
    expect(await readLock(dir)).toEqual({ lock: emptyLock(), existed: false });
  });

  it("drops malformed entries but keeps good ones", () => {
    const lock = parseLock({
      version: 1,
      generation: 3,
      skills: { good: entry(), noSha: { ...entry(), content_sha256: "" }, junk: 5 },
    });
    expect(Object.keys(lock.skills)).toEqual(["good"]);
    expect(lock.generation).toBe(3);
  });

  it("drops entries whose slug isn't a valid skill slug (a slug becomes a path)", () => {
    const lock = parseLock({ version: 1, generation: 1, skills: { "../../etc": entry(), ok: entry(), "A B": entry() } });
    expect(Object.keys(lock.skills)).toEqual(["ok"]);
  });

  it("serializes with sorted slugs so an unchanged lock rewrites byte-identically", () => {
    const a: SkillLock = { version: 1, generation: 1, skills: { zeta: entry(), alpha: entry() } };
    const b: SkillLock = { version: 1, generation: 1, skills: { alpha: entry(), zeta: entry() } };
    expect(serializeLock(a)).toBe(serializeLock(b));
    expect(Object.keys(JSON.parse(serializeLock(a)).skills)).toEqual(["alpha", "zeta"]);
  });

  it("clearLock removes the file", async () => {
    await writeLock(dir, emptyLock());
    await clearLock(dir);
    expect((await readLock(dir)).existed).toBe(false);
  });
});

describe("lockDigest", () => {
  it("is sha256 over byte-wise sorted slug@content_sha256 lines", () => {
    const lock: SkillLock = {
      version: 1,
      generation: 1,
      skills: { "a-b": entry({ content_sha256: SHA_B }), a: entry({ content_sha256: SHA_A }) },
    };
    // "a-b@…" sorts before "a@…" ('-' < '@'), regardless of slug order.
    expect(lockDigest(lock)).toBe(sha256Hex(`a-b@${SHA_B}\na@${SHA_A}`));
  });

  it("digests the empty string for an empty lock", () => {
    expect(lockDigest(emptyLock())).toBe(sha256Hex(""));
  });
});

describe("revFor / lockSkillEntries", () => {
  it("uses the first 12 hex chars of a digest, hashing non-hex legacy markers first", () => {
    expect(revFor(SHA_A)).toBe(SHA_A.slice(0, 12));
    expect(revFor("clawhub:1.2.0")).toBe(sha256Hex("clawhub:1.2.0").slice(0, 12));
  });

  it("emits one { config: { rev } } per skill, keyed by skill_key or slug, keys sorted", () => {
    const lock: SkillLock = {
      version: 1,
      generation: 1,
      skills: {
        zeta: entry({ content_sha256: SHA_B }),
        keyed: entry({ skill_key: "custom-key" }),
        legacy: entry({ source: "clawhub", content_sha256: "clawhub:latest" }),
      },
    };
    const entries = lockSkillEntries(lock);
    expect(Object.keys(entries)).toEqual(["custom-key", "legacy", "zeta"]);
    expect(entries.zeta).toEqual({ config: { rev: SHA_B.slice(0, 12) } });
    expect(entries["custom-key"]).toEqual({ config: { rev: SHA_A.slice(0, 12) } });
  });

  it("is empty for an empty lock", () => {
    expect(lockSkillEntries(emptyLock())).toEqual({});
  });

  it("persists across writes (the lock file is the source for boot config)", async () => {
    await writeLock(dir, { version: 1, generation: 2, skills: { alpha: entry() } });
    const raw = JSON.parse(await readFile(join(dir, LOCK_FILE), "utf8"));
    expect(raw.skills.alpha.content_sha256).toBe(SHA_A);
  });
});
