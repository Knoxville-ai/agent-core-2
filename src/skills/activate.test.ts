import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256Hex, type ManifestEntry } from "./contract.js";
import {
  listSkillDirs,
  materialize,
  quarantineSkillDir,
  removeSkillDir,
  SkillContentError,
  swapIntoPlace,
  validateStagedSkill,
  verifySkillDir,
  workspaceDirs,
  type BlobSource,
} from "./activate.js";

/** In-memory blob source keyed by sha256. */
function blobsOf(bodies: string[]): BlobSource {
  const map = new Map(bodies.map((b) => [sha256Hex(b), Buffer.from(b)]));
  return {
    async read(sha) {
      const b = map.get(sha);
      if (!b) throw new Error(`no blob ${sha}`);
      return b;
    },
  };
}

function file(path: string, body: string, executable = false): ManifestEntry {
  return { path, sha256: sha256Hex(body), size: Buffer.byteLength(body), executable };
}

const SKILL_MD = "---\nname: hello-world\ndescription: Say hello.\n---\n\n# hello\n";
const SCRIPT = "#!/usr/bin/env python3\nprint('hi')\n";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "knox-activate-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("materialize", () => {
  it("writes every file with 0644, or 0755 when executable, creating parent dirs", async () => {
    const dest = join(root, "stage");
    await materialize(
      [file("SKILL.md", SKILL_MD), file("scripts/hello.py", SCRIPT, true)],
      dest,
      blobsOf([SKILL_MD, SCRIPT]),
    );
    expect(await readFile(join(dest, "SKILL.md"), "utf8")).toBe(SKILL_MD);
    expect((await stat(join(dest, "SKILL.md"))).mode & 0o777).toBe(0o644);
    expect((await stat(join(dest, "scripts/hello.py"))).mode & 0o777).toBe(0o755);
  });

  it.each(["../escape.txt", "/abs.txt", "a/../../b", "a\\b", "with space"])(
    "rejects the unsafe path %j before writing anything",
    async (bad) => {
      const dest = join(root, "stage");
      await expect(
        materialize([file("SKILL.md", SKILL_MD), file(bad, "x")], dest, blobsOf([SKILL_MD, "x"])),
      ).rejects.toBeInstanceOf(SkillContentError);
      await expect(stat(dest)).rejects.toThrow(); // nothing created
      await expect(stat(join(root, "escape.txt"))).rejects.toThrow();
    },
  );

  it("starts from a fresh directory (stale staging content is removed)", async () => {
    const dest = join(root, "stage");
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "stale.txt"), "old");
    await materialize([file("SKILL.md", SKILL_MD)], dest, blobsOf([SKILL_MD]));
    expect(await readdir(dest)).toEqual(["SKILL.md"]);
  });

  it("uses exclusive create: colliding manifest paths fail instead of overwriting", async () => {
    const dest = join(root, "stage");
    await expect(
      materialize(
        [file("SKILL.md", SKILL_MD), file("a", "file"), file("a/b", "nested")],
        dest,
        blobsOf([SKILL_MD, "file", "nested"]),
      ),
    ).rejects.toThrow(/collide/);
    await expect(
      materialize(
        [file("SKILL.md", SKILL_MD), file("SKILL.md", SKILL_MD)],
        dest,
        blobsOf([SKILL_MD]),
      ),
    ).rejects.toThrow(/collide/);
  });

  it("never follows a pre-planted symlink (O_EXCL on a fresh dir)", async () => {
    // Even if something raced a symlink into place, wx refuses to open it.
    const dest = join(root, "stage");
    const outside = join(root, "outside.txt");
    await writeFile(outside, "untouched");
    const blobs = blobsOf([SKILL_MD, "payload"]);
    const racing: BlobSource = {
      async read(sha) {
        if (sha === sha256Hex("payload")) {
          await symlink(outside, join(dest, "link.txt")).catch(() => {});
        }
        return blobs.read(sha);
      },
    };
    await expect(
      materialize([file("SKILL.md", SKILL_MD), file("link.txt", "payload")], dest, racing),
    ).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("untouched");
  });

  it("rejects a body that doesn't match its manifest entry", async () => {
    const lying: BlobSource = { read: async () => Buffer.from("not the skill") };
    await expect(
      materialize([file("SKILL.md", SKILL_MD)], join(root, "stage"), lying),
    ).rejects.toThrow(/does not match/);
  });
});

describe("validateStagedSkill", () => {
  async function stage(md: string | null): Promise<string> {
    const dir = join(root, "s");
    await mkdir(dir, { recursive: true });
    if (md !== null) await writeFile(join(dir, "SKILL.md"), md);
    return dir;
  }

  it("accepts SKILL.md whose frontmatter name equals the slug", async () => {
    const { frontmatter } = await validateStagedSkill(await stage(SKILL_MD), "hello-world");
    expect(frontmatter.name).toBe("hello-world");
  });

  it("refuses a missing SKILL.md or a name that isn't the slug", async () => {
    await expect(validateStagedSkill(await stage(null), "x")).rejects.toThrow(/missing/);
    await expect(validateStagedSkill(await stage(SKILL_MD), "other")).rejects.toThrow(/does not match/);
  });

  it("accepts frontmatter strict YAML rejects (parsed line by line, like OpenClaw)", async () => {
    const md =
      "---\nname: keeper-credentials\ndescription: Scoped: never the master password\nversion: 0.1.0\n---\n# k\n";
    await expect(validateStagedSkill(await stage(md), "keeper-credentials")).resolves.toBeTruthy();
  });

  it("never refuses a skill for a long description", async () => {
    const md = `---\nname: wordy\ndescription: ${"x".repeat(1900)}\n---\n`;
    await expect(validateStagedSkill(await stage(md), "wordy")).resolves.toBeTruthy();
  });
});

describe("swap / remove / quarantine", () => {
  async function makeSkill(dir: string, body: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), body);
  }

  it("swaps a staged folder in, replacing (and deleting) the live one", async () => {
    const dirs = workspaceDirs(root);
    await makeSkill(join(dirs.skills, "alpha"), "v1");
    await makeSkill(join(dirs.staging, "alpha-new"), "v2");
    const r = await swapIntoPlace(dirs, "alpha", join(dirs.staging, "alpha-new"));
    expect(r.replaced).toBe(true);
    expect(await readFile(join(dirs.skills, "alpha", "SKILL.md"), "utf8")).toBe("v2");
    expect(await readdir(dirs.trash)).toEqual([]);
  });

  it("preserves a folder it doesn't own in .skills-unmanaged", async () => {
    const dirs = workspaceDirs(root);
    await makeSkill(join(dirs.skills, "alpha"), "hand-written");
    await makeSkill(join(dirs.staging, "alpha-new"), "library");
    const r = await swapIntoPlace(dirs, "alpha", join(dirs.staging, "alpha-new"), { preserveExisting: true });
    expect(r.quarantinedTo).toBeDefined();
    expect(await readFile(join(r.quarantinedTo!, "SKILL.md"), "utf8")).toBe("hand-written");
    expect(await readFile(join(dirs.skills, "alpha", "SKILL.md"), "utf8")).toBe("library");
  });

  it("removes and quarantines; lists only visible skill dirs", async () => {
    const dirs = workspaceDirs(root);
    await makeSkill(join(dirs.skills, "gone"), "x");
    await makeSkill(join(dirs.skills, "mine"), "y");
    await mkdir(join(dirs.skills, ".clawhub"), { recursive: true });
    await writeFile(join(dirs.skills, "README.txt"), "not a skill");
    expect(await listSkillDirs(dirs)).toEqual(["gone", "mine"]);

    expect(await removeSkillDir(dirs, "gone")).toBe(true);
    const dest = await quarantineSkillDir(dirs, "mine");
    expect(await readFile(join(dest, "SKILL.md"), "utf8")).toBe("y");
    expect(await listSkillDirs(dirs)).toEqual([]);
  });

  it("verifySkillDir re-hashes manifest files and ignores extras like __pycache__", async () => {
    const dirs = workspaceDirs(root);
    const live = join(dirs.skills, "hello-world");
    await makeSkill(live, SKILL_MD);
    await mkdir(join(live, "__pycache__"), { recursive: true });
    await writeFile(join(live, "__pycache__", "x.pyc"), "bytecode");
    const manifest = [file("SKILL.md", SKILL_MD)];
    expect(await verifySkillDir(dirs, "hello-world", manifest)).toBe(true);
    await writeFile(join(live, "SKILL.md"), SKILL_MD.replace("hello", "HELLO"));
    expect(await verifySkillDir(dirs, "hello-world", manifest)).toBe(false);
  });
});
