import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClawhubSkillResolver } from "./clawhub.js";
import {
  ClawhubIntegrityError,
  PIN_FILE,
  clawhubIntegrityMode,
  normalizeIntegrityHash,
  skillFolderDigest,
  verifyClawhubInstall,
} from "./clawhub-integrity.js";
import { manifestDigest, sha256Hex } from "./contract.js";

let base: string;
let stateDir: string;
let skillsDir: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "clawhub-integrity-"));
  stateDir = join(base, "state");
  skillsDir = join(stateDir, "workspace", "skills");
  await mkdir(skillsDir, { recursive: true });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function writeSkill(slug: string, body: string, installedVersion?: string): Promise<string> {
  const dir = join(skillsDir, slug);
  await mkdir(join(dir, "scripts"), { recursive: true });
  await writeFile(join(dir, "SKILL.md"), body);
  await writeFile(join(dir, "scripts", "run.py"), "print('hi')\n");
  await chmod(join(dir, "scripts", "run.py"), 0o755);
  if (installedVersion) {
    await mkdir(join(dir, ".clawhub"), { recursive: true });
    await writeFile(
      join(dir, ".clawhub", "origin.json"),
      JSON.stringify({ version: 1, registry: "r", slug, installedVersion, installedAt: Date.now() }),
    );
  }
  return dir;
}

function expectedDigest(body: string): string {
  return manifestDigest([
    { path: "SKILL.md", sha256: sha256Hex(body), size: Buffer.byteLength(body), executable: false },
    { path: "scripts/run.py", sha256: sha256Hex("print('hi')\n"), size: 12, executable: true },
  ]);
}

describe("skillFolderDigest", () => {
  it("equals the library manifestDigest and ignores ClawHub install metadata", async () => {
    const dir = await writeSkill("s", "# skill\n", "1.0.0");
    expect(await skillFolderDigest(dir)).toBe(expectedDigest("# skill\n"));
    await writeFile(join(dir, ".clawhub", "origin.json"), "{\"installedAt\": 2}");
    expect(await skillFolderDigest(dir)).toBe(expectedDigest("# skill\n"));
  });

  it("changes when any byte or exec bit changes", async () => {
    const dir = await writeSkill("s", "# skill\n");
    const before = await skillFolderDigest(dir);
    await chmod(join(dir, "scripts", "run.py"), 0o644);
    expect(await skillFolderDigest(dir)).not.toBe(before);
  });

  it("refuses a folder containing a symlink", async () => {
    const dir = await writeSkill("s", "# skill\n");
    await symlink("/etc/hostname", join(dir, "link"));
    await expect(skillFolderDigest(dir)).rejects.toBeInstanceOf(ClawhubIntegrityError);
  });
});

describe("normalizeIntegrityHash / mode", () => {
  const h = "a".repeat(64);
  it("accepts bare, prefixed and upper-case hex; null for absent", () => {
    expect(normalizeIntegrityHash("s", h)).toBe(h);
    expect(normalizeIntegrityHash("s", `sha256:${h.toUpperCase()}`)).toBe(h);
    expect(normalizeIntegrityHash("s", `sha256-${h}`)).toBe(h);
    expect(normalizeIntegrityHash("s", undefined)).toBeNull();
    expect(normalizeIntegrityHash("s", null)).toBeNull();
    expect(normalizeIntegrityHash("s", "  ")).toBeNull();
  });
  it("throws for a present but malformed hash", () => {
    expect(() => normalizeIntegrityHash("s", "abc")).toThrow(ClawhubIntegrityError);
    expect(() => normalizeIntegrityHash("s", 42)).toThrow(ClawhubIntegrityError);
  });
  it("reads CLAWHUB_INTEGRITY", () => {
    expect(clawhubIntegrityMode({})).toBe("pin");
    expect(clawhubIntegrityMode({ CLAWHUB_INTEGRITY: "require" })).toBe("require");
    expect(clawhubIntegrityMode({ CLAWHUB_INTEGRITY: "ENFORCE" })).toBe("require");
    expect(clawhubIntegrityMode({ CLAWHUB_INTEGRITY: "off" })).toBe("pin");
  });
});

describe("verifyClawhubInstall", () => {
  it("passes when the digest matches the expected hash", async () => {
    const dir = await writeSkill("s", "# skill\n", "1.0.0");
    const v = await verifyClawhubInstall({
      req: { source: "clawhub", ref: "s", version: "1.0.0", integrityHash: expectedDigest("# skill\n") },
      dir,
      stateDir,
      mode: "require",
    });
    expect(v).toMatchObject({ basis: "expected", version: "1.0.0" });
  });

  it("fails on a hash mismatch, in either mode", async () => {
    const dir = await writeSkill("s", "# tampered\n", "1.0.0");
    for (const mode of ["pin", "require"] as const) {
      await expect(
        verifyClawhubInstall({
          req: { source: "clawhub", ref: "s", version: "1.0.0", integrityHash: expectedDigest("# skill\n") },
          dir,
          stateDir,
          mode,
        }),
      ).rejects.toMatchObject({ reason: "mismatch" });
    }
  });

  it("fails for a malformed expected hash", async () => {
    const dir = await writeSkill("s", "# skill\n", "1.0.0");
    await expect(
      verifyClawhubInstall({ req: { source: "clawhub", ref: "s", version: "1", integrityHash: "nope" }, dir, stateDir }),
    ).rejects.toMatchObject({ reason: "bad_hash" });
  });

  it("require mode refuses an install without a hash", async () => {
    const dir = await writeSkill("s", "# skill\n", "1.0.0");
    await expect(
      verifyClawhubInstall({ req: { source: "clawhub", ref: "s", version: "1.0.0" }, dir, stateDir, mode: "require" }),
    ).rejects.toMatchObject({ reason: "missing_hash" });
  });

  it("pin mode records the first install and refuses changed content for the same version", async () => {
    const dir = await writeSkill("s", "# skill\n", "1.0.0");
    const first = await verifyClawhubInstall({ req: { source: "clawhub", ref: "s", version: "" }, dir, stateDir, mode: "pin" });
    expect(first).toMatchObject({ basis: "pinned", version: "1.0.0" });
    const pins = JSON.parse(await readFile(join(stateDir, PIN_FILE), "utf8"));
    expect(pins.pins["s@1.0.0"]).toBe(expectedDigest("# skill\n"));

    // Same content again: fine.
    await verifyClawhubInstall({ req: { source: "clawhub", ref: "s", version: "1.0.0" }, dir, stateDir, mode: "pin" });

    // Same version, different bytes: refused.
    await writeFile(join(dir, "SKILL.md"), "# republished\n");
    await expect(
      verifyClawhubInstall({ req: { source: "clawhub", ref: "s", version: "1.0.0" }, dir, stateDir, mode: "pin" }),
    ).rejects.toMatchObject({ reason: "pin_mismatch" });

    // A new version is a new pin.
    await writeFile(
      join(dir, ".clawhub", "origin.json"),
      JSON.stringify({ version: 1, registry: "r", slug: "s", installedVersion: "1.1.0", installedAt: 1 }),
    );
    expect(
      await verifyClawhubInstall({ req: { source: "clawhub", ref: "s", version: "" }, dir, stateDir, mode: "pin" }),
    ).toMatchObject({ basis: "pinned", version: "1.1.0" });
  });

  it("an expected hash takes precedence over (and replaces) an older pin", async () => {
    const dir = await writeSkill("s", "# skill\n", "1.0.0");
    await verifyClawhubInstall({ req: { source: "clawhub", ref: "s", version: "1.0.0" }, dir, stateDir, mode: "pin" });
    await writeFile(join(dir, "SKILL.md"), "# fixed\n");
    await verifyClawhubInstall({
      req: { source: "clawhub", ref: "s", version: "1.0.0", integrityHash: expectedDigest("# fixed\n") },
      dir,
      stateDir,
      mode: "pin",
    });
    const pins = JSON.parse(await readFile(join(stateDir, PIN_FILE), "utf8"));
    expect(pins.pins["s@1.0.0"]).toBe(expectedDigest("# fixed\n"));
  });
});

describe("ClawhubSkillResolver integrity", () => {
  /** A stand-in for `openclaw skills install <slug> ...` that writes the
   *  folder from FAKE_SKILL_BODY into FAKE_SKILLS_DIR. */
  async function fakeOpenclaw(): Promise<string> {
    const bin = join(base, "fake-openclaw");
    await writeFile(
      bin,
      [
        "#!/bin/sh",
        'slug="$3"',
        'd="$FAKE_SKILLS_DIR/$slug"',
        'rm -rf "$d" && mkdir -p "$d/scripts" "$d/.clawhub"',
        'printf "%s" "$FAKE_SKILL_BODY" > "$d/SKILL.md"',
        "printf \"print('hi')\\n\" > \"$d/scripts/run.py\"",
        'chmod 755 "$d/scripts/run.py"',
        'printf \'{"version":1,"registry":"r","slug":"%s","installedVersion":"1.0.0","installedAt":1}\' "$slug" > "$d/.clawhub/origin.json"',
        "",
      ].join("\n"),
    );
    await chmod(bin, 0o755);
    process.env.FAKE_SKILLS_DIR = skillsDir;
    return bin;
  }

  afterEach(() => {
    delete process.env.FAKE_SKILLS_DIR;
    delete process.env.FAKE_SKILL_BODY;
  });

  it("returns the install when the content matches integrityHash", async () => {
    const binary = await fakeOpenclaw();
    process.env.FAKE_SKILL_BODY = "# skill\n";
    const r = new ClawhubSkillResolver({ stateDir, binary, integrityMode: "require" });
    const out = await r.install(
      { source: "clawhub", ref: "web-search", version: "1.0.0", integrityHash: expectedDigest("# skill\n") },
      skillsDir,
    );
    expect(out.path).toBe(join(skillsDir, "web-search"));
  });

  it("refuses and removes the folder on a hash mismatch", async () => {
    const binary = await fakeOpenclaw();
    process.env.FAKE_SKILL_BODY = "# other content\n";
    const r = new ClawhubSkillResolver({ stateDir, binary, integrityMode: "pin" });
    await expect(
      r.install(
        { source: "clawhub", ref: "web-search", version: "1.0.0", integrityHash: expectedDigest("# skill\n") },
        skillsDir,
      ),
    ).rejects.toMatchObject({ reason: "mismatch" });
    await expect(stat(join(skillsDir, "web-search"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("require mode refuses and removes an unhashed install", async () => {
    const binary = await fakeOpenclaw();
    process.env.FAKE_SKILL_BODY = "# skill\n";
    const r = new ClawhubSkillResolver({ stateDir, binary, integrityMode: "require" });
    await expect(r.install({ source: "clawhub", ref: "web-search", version: "" }, skillsDir)).rejects.toMatchObject({
      reason: "missing_hash",
    });
    await expect(stat(join(skillsDir, "web-search"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pin mode refuses a changed re-download of the same version", async () => {
    const binary = await fakeOpenclaw();
    const r = new ClawhubSkillResolver({ stateDir, binary, integrityMode: "pin" });
    process.env.FAKE_SKILL_BODY = "# skill\n";
    await r.install({ source: "clawhub", ref: "web-search", version: "" }, skillsDir);
    process.env.FAKE_SKILL_BODY = "# changed upstream\n";
    await expect(r.install({ source: "clawhub", ref: "web-search", version: "" }, skillsDir)).rejects.toMatchObject({
      reason: "pin_mismatch",
    });
    await expect(stat(join(skillsDir, "web-search"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a slug that is not a plain name before running anything", async () => {
    const r = new ClawhubSkillResolver({ stateDir, binary: join(base, "does-not-exist") });
    await expect(r.install({ source: "clawhub", ref: "../escape", version: "" }, skillsDir)).rejects.toThrow(
      /invalid clawhub skill slug/,
    );
  });
});
