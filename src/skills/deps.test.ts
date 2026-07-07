import { describe, expect, it } from "vitest";

import {
  collectSkillDeps,
  extractUvRequirements,
  needsChromium,
  parseFrontmatter,
  requirementName,
} from "./deps.js";

const skillMd = (frontmatter: string): string => `---\n${frontmatter}\n---\n\n# body\n`;

describe("parseFrontmatter", () => {
  it("parses the leading --- fenced YAML block", () => {
    const md = skillMd("name: drivethru-odoo\nmetadata:\n  openclaw:\n    install:\n      uv:\n        - mcp>=1.9.0");
    expect(parseFrontmatter(md)).toMatchObject({
      name: "drivethru-odoo",
      metadata: { openclaw: { install: { uv: ["mcp>=1.9.0"] } } },
    });
  });

  it("tolerates a leading UTF-8 BOM and CRLF newlines", () => {
    const md = `\uFEFF---\r\nname: x\r\n---\r\nbody`;
    expect(parseFrontmatter(md)).toEqual({ name: "x" });
  });

  it("returns null when there is no frontmatter or it is malformed", () => {
    expect(parseFrontmatter("# just a heading\n")).toBeNull();
    expect(parseFrontmatter("---\n: : not : valid : yaml\n---")).toBeNull();
  });
});

describe("extractUvRequirements", () => {
  it("pulls trimmed, non-empty strings from metadata.openclaw.install.uv", () => {
    const fm = {
      metadata: { openclaw: { install: { uv: ["  mcp>=1.9.0  ", "httpx", "", 42, null] } } },
    };
    expect(extractUvRequirements(fm)).toEqual(["mcp>=1.9.0", "httpx"]);
  });

  it("returns [] when any level of the path is absent or the wrong type", () => {
    expect(extractUvRequirements(null)).toEqual([]);
    expect(extractUvRequirements({})).toEqual([]);
    expect(extractUvRequirements({ metadata: { openclaw: {} } })).toEqual([]);
    expect(extractUvRequirements({ metadata: { openclaw: { install: { uv: "mcp" } } } })).toEqual([]);
  });
});

describe("requirementName", () => {
  it("extracts and normalizes the pip package name from a PEP 508 spec", () => {
    expect(requirementName("mcp>=1.9.0")).toBe("mcp");
    expect(requirementName("Playwright[chromium]>=1.40")).toBe("playwright");
    expect(requirementName("scikit_image==0.24; python_version>='3.10'")).toBe("scikit-image");
    expect(requirementName("some.pkg @ git+https://x")).toBe("some-pkg");
  });
});

describe("needsChromium", () => {
  it("is true iff a requirement is the playwright package", () => {
    expect(needsChromium(["mcp>=1.9.0", "playwright>=1.40"])).toBe(true);
    expect(needsChromium(["Playwright"])).toBe(true);
    expect(needsChromium(["mcp>=1.9.0", "httpx"])).toBe(false);
    // Substring lookalikes must not trigger a browser install.
    expect(needsChromium(["playwright-stealth"])).toBe(false);
  });
});

describe("collectSkillDeps", () => {
  const read = (files: Record<string, string>) => async (dir: string) => files[dir] ?? null;

  it("unions install.uv across skills, deduped in stable first-seen order", async () => {
    const files = {
      "/ws/drivethru-odoo": skillMd("metadata:\n  openclaw:\n    install:\n      uv: [mcp>=1.9.0, httpx]"),
      "/ws/drivethru-adidas-click": skillMd("metadata:\n  openclaw:\n    install:\n      uv: [playwright>=1.40, httpx]"),
    };
    const out = await collectSkillDeps(
      [
        { ref: "drivethru-odoo", path: "/ws/drivethru-odoo" },
        { ref: "drivethru-adidas-click", path: "/ws/drivethru-adidas-click" },
      ],
      read(files),
    );
    expect(out.requirements).toEqual(["mcp>=1.9.0", "httpx", "playwright>=1.40"]);
    expect(out.needsChromium).toBe(true);
    expect(out.skillsWithDeps).toEqual(["drivethru-odoo", "drivethru-adidas-click"]);
  });

  it("skips skills with a missing SKILL.md or no install.uv", async () => {
    const files = {
      "/ws/with-deps": skillMd("metadata:\n  openclaw:\n    install:\n      uv: [mcp>=1.9.0]"),
      "/ws/no-frontmatter": "# plain skill, no deps\n",
    };
    const out = await collectSkillDeps(
      [
        { ref: "with-deps", path: "/ws/with-deps" },
        { ref: "no-frontmatter", path: "/ws/no-frontmatter" },
        { ref: "absent", path: "/ws/absent" }, // read returns null
      ],
      read(files),
    );
    expect(out.requirements).toEqual(["mcp>=1.9.0"]);
    expect(out.needsChromium).toBe(false);
    expect(out.skillsWithDeps).toEqual(["with-deps"]);
  });

  it("returns empty results when nothing declares deps", async () => {
    const out = await collectSkillDeps([{ ref: "x", path: "/ws/x" }], async () => null);
    expect(out).toEqual({ requirements: [], needsChromium: false, skillsWithDeps: [] });
  });
});
