import { resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { safeSkillDir } from "./routes-skills.js";

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
