import { describe, expect, it } from "vitest";

import type { SkillRequirement } from "../bundle/types.js";
import type { InstalledSkill, SkillResolver } from "./resolver.js";
import { parseBootList } from "./boot-list.js";
import { installBootListSkills } from "./install.js";

describe("parseBootList", () => {
  it("maps slug + version to clawhub requirements", () => {
    const reqs = parseBootList({
      version: 1,
      skills: [
        { slug: "stripe-checkout", version: "0.1.0", addedAt: "x" },
        { slug: "web-search", version: null, addedAt: "y" },
      ],
    });
    expect(reqs).toEqual([
      { source: "clawhub", ref: "stripe-checkout", version: "0.1.0" },
      { source: "clawhub", ref: "web-search", version: "" },
    ]);
  });

  it("skips malformed entries and de-dupes slugs", () => {
    const reqs = parseBootList({
      skills: [
        { slug: "a", version: "1" },
        { version: "2" }, // no slug
        { slug: "" }, // empty slug
        { slug: "a", version: "9" }, // duplicate ref
        null,
        "nonsense",
      ],
    });
    expect(reqs).toEqual([{ source: "clawhub", ref: "a", version: "1" }]);
  });

  it("returns [] for absent / malformed documents", () => {
    expect(parseBootList(null)).toEqual([]);
    expect(parseBootList({})).toEqual([]);
    expect(parseBootList({ skills: "no" })).toEqual([]);
  });
});

/** Records installs; can be told to throw for specific refs. */
class FakeResolver implements SkillResolver {
  installed: string[] = [];
  constructor(private readonly failRefs: Set<string> = new Set()) {}
  async install(req: SkillRequirement): Promise<InstalledSkill> {
    if (this.failRefs.has(req.ref)) throw new Error(`boom ${req.ref}`);
    this.installed.push(req.ref);
    return { ref: req.ref, version: req.version, path: `/ws/${req.ref}`, source: "clawhub" };
  }
}

describe("installBootListSkills", () => {
  const reqs = (refs: string[]): SkillRequirement[] =>
    refs.map((ref) => ({ source: "clawhub", ref, version: "" }));

  it("installs each requirement, skipping refs already installed by the bundle", async () => {
    const resolver = new FakeResolver();
    const out = await installBootListSkills(reqs(["a", "b"]), "/ws", resolver, {
      skip: new Set(["a"]), // 'a' came from the bundle
    });
    expect(resolver.installed).toEqual(["b"]);
    expect(out.map((s) => s.ref)).toEqual(["b"]);
  });

  it("soft-fails on a bad skill and keeps installing the rest", async () => {
    const resolver = new FakeResolver(new Set(["bad"]));
    const out = await installBootListSkills(reqs(["ok1", "bad", "ok2"]), "/ws", resolver, {
      skip: new Set(),
    });
    expect(resolver.installed).toEqual(["ok1", "ok2"]);
    expect(out.map((s) => s.ref)).toEqual(["ok1", "ok2"]);
  });

  it("de-dupes repeated refs within the list", async () => {
    const resolver = new FakeResolver();
    await installBootListSkills(reqs(["x", "x", "y"]), "/ws", resolver, {
      skip: new Set(),
    });
    expect(resolver.installed).toEqual(["x", "y"]);
  });
});
