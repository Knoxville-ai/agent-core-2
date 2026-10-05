import { describe, expect, it } from "vitest";

import {
  isSafeSkillPath,
  isSha256,
  isValidSkillSlug,
  manifestDigest,
  sha256Hex,
  validateManifest,
  type ManifestEntry,
} from "./contract.js";

/** The cross-repo golden vector: the console computes the same digest. */
const SKILL_MD = "---\nname: hello-world\ndescription: Say hello.\n---\n\n# hello\n";
const SCRIPT = "#!/usr/bin/env python3\nprint('hi')\n";

describe("manifestDigest (golden vector shared with the console)", () => {
  const entries: ManifestEntry[] = [
    { path: "SKILL.md", sha256: sha256Hex(SKILL_MD), size: Buffer.byteLength(SKILL_MD), executable: false },
    { path: "scripts/hello.py", sha256: sha256Hex(SCRIPT), size: Buffer.byteLength(SCRIPT), executable: true },
  ];

  it("hashes the file bodies to the published values", () => {
    expect(entries[0]).toEqual({
      path: "SKILL.md",
      sha256: "79455b9dd074c445d8cec0bb607a889dccf7e58dd041bcde018286939b4ecdcc",
      size: 59,
      executable: false,
    });
    expect(entries[1]).toEqual({
      path: "scripts/hello.py",
      sha256: "34d2351de9d02066419450721cd11a90c38be0720d5fca8543e3ed043f0ade50",
      size: 35,
      executable: true,
    });
  });

  it("produces the golden manifest digest", () => {
    expect(manifestDigest(entries)).toBe(
      "99a791ad5ea75b91b26a30a0eba065350cfcd6c1eb4750d71a82da9dc5318a30",
    );
  });

  it("is independent of manifest order", () => {
    expect(manifestDigest([entries[1]!, entries[0]!])).toBe(manifestDigest(entries));
  });

  it("changes with any path, byte, size or exec bit", () => {
    const base = manifestDigest(entries);
    const flip = (patch: Partial<ManifestEntry>) =>
      manifestDigest([{ ...entries[0]!, ...patch }, entries[1]!]);
    expect(flip({ executable: true })).not.toBe(base);
    expect(flip({ size: 60 })).not.toBe(base);
    expect(flip({ path: "skill.md" })).not.toBe(base);
    expect(flip({ sha256: sha256Hex("other") })).not.toBe(base);
  });
});

describe("isSafeSkillPath", () => {
  it.each(["SKILL.md", "scripts/run.py", "a/b/c/d/e/f.txt", "data/file-1_v2.json", ".hidden"])(
    "accepts %j",
    (p) => expect(isSafeSkillPath(p)).toBe(true),
  );

  it.each([
    "",
    "/etc/passwd",
    "../x",
    "a/../b",
    "./SKILL.md",
    "a/./b",
    "a\\b",
    "a//b",
    "a/b/",
    "has space.txt",
    "a/b/c/d/e/f/g.txt", // depth 7
    "x".repeat(256),
    "ünïcode.md",
    "semi;colon",
  ])("rejects %j", (p) => expect(isSafeSkillPath(p)).toBe(false));
});

describe("isValidSkillSlug / isSha256", () => {
  it("accepts kebab-case slugs up to 64 chars", () => {
    expect(isValidSkillSlug("drivethru-odoo")).toBe(true);
    expect(isValidSkillSlug("a")).toBe(true);
    expect(isValidSkillSlug("a".repeat(64))).toBe(true);
  });

  it.each(["", "A", "a--b", "-a", "a-", "a_b", "a/b", "..", "a".repeat(65)])("rejects slug %j", (s) =>
    expect(isValidSkillSlug(s)).toBe(false),
  );

  it("isSha256 wants 64 lowercase hex chars", () => {
    expect(isSha256(sha256Hex("x"))).toBe(true);
    expect(isSha256(sha256Hex("x").toUpperCase())).toBe(false);
    expect(isSha256("abc")).toBe(false);
  });
});

describe("validateManifest", () => {
  const ok: ManifestEntry = { path: "SKILL.md", sha256: sha256Hex("x"), size: 1, executable: false };

  it("accepts a minimal valid manifest", () => {
    expect(validateManifest([ok])).toEqual([]);
  });

  it("reports missing SKILL.md, bad paths, duplicates and bad hashes", () => {
    const codes = validateManifest([
      { ...ok, path: "README.md" },
      { ...ok, path: "../evil" },
      { ...ok, path: "README.md" },
      { ...ok, path: "x.txt", sha256: "nope" },
    ]).map((p) => p.code);
    expect(codes).toEqual(expect.arrayContaining(["missing_skill_md", "bad_path", "duplicate_path", "bad_hash"]));
  });
});
