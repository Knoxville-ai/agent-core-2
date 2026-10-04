import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectSkillDeps,
  depsHash,
  extractSkillKey,
  extractUvRequirements,
  needsChromium,
  parseFrontmatter,
  parseFrontmatterLines,
  provisionSkillDepsFor,
  requirementName,
  type DepsRunner,
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

describe("parseFrontmatter — lenient fallback (strict YAML rejects, OpenClaw loads)", () => {
  // keeper-credentials' exact shape: a one-line description with an unquoted
  // ": " (strict YAML: "Nested mappings are not allowed in compact mappings"),
  // followed by a nested metadata block.
  const KEEPER_LIKE = [
    "---",
    "name: keeper-credentials",
    "description: Let an agent broker credentials (a token over folders: the user's) safely",
    "version: 0.1.0",
    "emoji: 🔐",
    "metadata:",
    "  openclaw:",
    "    requires:",
    "      bins: [python3]",
    "    envVars:",
    "      KEEPER_SKILL_HOME:",
    "        required: false",
    "        description: >",
    "          Directory where the KSM config is persisted. MUST",
    "          point at storage that survives across sessions.",
    "    install:",
    "      uv:",
    "        - keeper-secrets-manager-core>=16.6.0",
    "        # Optional: only needed for One-Time Share delivery.",
    "        - keepercommander>=16.11.0",
    "---",
    "",
    "# Keeper credentials",
  ].join("\n");

  it("recovers name, description and install.uv from keeper-credentials' shape", () => {
    const fm = parseFrontmatter(KEEPER_LIKE);
    expect(fm?.name).toBe("keeper-credentials");
    expect(fm?.description).toBe(
      "Let an agent broker credentials (a token over folders: the user's) safely",
    );
    expect(fm?.version).toBe("0.1.0");
    expect(extractUvRequirements(fm)).toEqual([
      "keeper-secrets-manager-core>=16.6.0",
      "keepercommander>=16.11.0",
    ]);
    expect(
      (fm?.metadata as { openclaw: { envVars: { KEEPER_SKILL_HOME: { description: string } } } }).openclaw
        .envVars.KEEPER_SKILL_HOME.description,
    ).toContain("survives across sessions");
  });

  it("feeds collectSkillDeps too (its deps are no longer silently skipped)", async () => {
    const out = await collectSkillDeps([{ ref: "keeper-credentials", path: "/ws/k" }], async () => KEEPER_LIKE);
    expect(out.requirements).toEqual(["keeper-secrets-manager-core>=16.6.0", "keepercommander>=16.11.0"]);
  });

  it("strips one pair of surrounding quotes from a single-line value", () => {
    expect(parseFrontmatterLines(`name: "quoted: yes"\nother: 'single'\nbare: a: b`)).toEqual({
      name: "quoted: yes",
      other: "single",
      bare: "a: b",
    });
  });

  it("treats trailing blank/comment-only continuation as no continuation", () => {
    expect(parseFrontmatterLines("description: x: y\n\n# note\nname: n")).toEqual({
      description: "x: y",
      name: "n",
    });
  });

  it("skips an entry whose continuation block is unparseable on its own", () => {
    expect(parseFrontmatterLines("name: ok\nbroken: [1, 2\n  - : :\n")).toEqual({ name: "ok" });
  });

  it("prefers strict YAML when the block parses", () => {
    expect(parseFrontmatter("---\nname: 'a'\nn: 5\n---")).toEqual({ name: "a", n: 5 });
  });
});

describe("extractSkillKey", () => {
  it("reads metadata.openclaw.skillKey", () => {
    expect(extractSkillKey({ metadata: { openclaw: { skillKey: " my-key " } } })).toBe("my-key");
    expect(extractSkillKey({ metadata: { openclaw: {} } })).toBeNull();
    expect(extractSkillKey(null)).toBeNull();
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

describe("depsHash", () => {
  it("is null without requirements or without a venv identity", () => {
    expect(depsHash([], "venv-1")).toBeNull();
    expect(depsHash(["mcp>=1.9.0"], null)).toBeNull();
  });

  it("changes with the requirement list and with the venv instance", () => {
    const base = depsHash(["mcp>=1.9.0"], "venv-1");
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(depsHash(["mcp>=1.9.0"], "venv-1")).toBe(base);
    expect(depsHash(["mcp>=1.10.0"], "venv-1")).not.toBe(base);
    // A fresh container (new venv) must re-provision even unchanged requirements.
    expect(depsHash(["mcp>=1.9.0"], "venv-2")).not.toBe(base);
  });
});

describe("provisionSkillDepsFor", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "knox-deps-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function runner(over: Partial<DepsRunner> = {}): DepsRunner & { installs: string[][]; chromium: number } {
    const r = {
      installs: [] as string[][],
      chromium: 0,
      interpreter: async () => ({ python: "/opt/skills-venv/bin/python3", venvId: "venv-1" }),
      install: async (_python: string, reqs: string[]) => {
        r.installs.push(reqs);
        return { ok: true };
      },
      installChromium: async () => {
        r.chromium += 1;
        return { ok: true };
      },
      ...over,
    };
    return r;
  }

  async function skill(frontmatter: string): Promise<string> {
    const d = join(dir, "s");
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "SKILL.md"), skillMd(frontmatter));
    return d;
  }

  it("does nothing for a skill without install.uv", async () => {
    const r = runner();
    const out = await provisionSkillDepsFor(await skill("name: s"), { runner: r });
    expect(out).toEqual({ ok: true, skipped: true, hash: null, requirements: [] });
    expect(r.installs).toEqual([]);
  });

  it("installs, returns the hash to record, and adds Chromium for Playwright", async () => {
    const r = runner();
    const d = await skill("name: s\nmetadata:\n  openclaw:\n    install:\n      uv: [playwright>=1.40]");
    const out = await provisionSkillDepsFor(d, { runner: r });
    expect(out.ok).toBe(true);
    expect(out.skipped).toBe(false);
    expect(out.hash).toBe(depsHash(["playwright>=1.40"], "venv-1"));
    expect(r.installs).toEqual([["playwright>=1.40"]]);
    expect(r.chromium).toBe(1);
  });

  it("skips uv entirely when the hash matches what the lock recorded", async () => {
    const r = runner();
    const d = await skill("name: s\nmetadata:\n  openclaw:\n    install:\n      uv: [mcp>=1.9.0]");
    const out = await provisionSkillDepsFor(d, { runner: r, previousHash: depsHash(["mcp>=1.9.0"], "venv-1") });
    expect(out).toMatchObject({ ok: true, skipped: true });
    expect(r.installs).toEqual([]);
  });

  it("re-installs in a fresh venv even when the requirements are unchanged", async () => {
    const r = runner({ interpreter: async () => ({ python: "/p", venvId: "venv-2" }) });
    const d = await skill("name: s\nmetadata:\n  openclaw:\n    install:\n      uv: [mcp>=1.9.0]");
    await provisionSkillDepsFor(d, { runner: r, previousHash: depsHash(["mcp>=1.9.0"], "venv-1") });
    expect(r.installs).toEqual([["mcp>=1.9.0"]]);
  });

  it("returns { ok: false, error } with the failure tail and no hash", async () => {
    const r = runner({ install: async () => ({ ok: false, error: "exit 1: No solution found" }) });
    const d = await skill("name: s\nmetadata:\n  openclaw:\n    install:\n      uv: [nope==0]");
    const out = await provisionSkillDepsFor(d, { runner: r });
    expect(out).toMatchObject({ ok: false, hash: null, error: "exit 1: No solution found" });
  });

  it("fails when there is no python3 to install into", async () => {
    const r = runner({ interpreter: async () => null });
    const d = await skill("name: s\nmetadata:\n  openclaw:\n    install:\n      uv: [mcp]");
    expect((await provisionSkillDepsFor(d, { runner: r })).ok).toBe(false);
  });
});
