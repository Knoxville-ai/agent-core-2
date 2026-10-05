import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseCheckOutput, parseSkillsCheck } from "./eligibility.js";

/** Real `openclaw skills check --json` output from openclaw 2026.5.20 (bundled
 *  list trimmed), with three workspace skills missing an env var / binaries. */
const FIXTURE = readFileSync(
  new URL("./__fixtures__/skills-check-2026.5.20.json", import.meta.url),
  "utf8",
);

describe("parseSkillsCheck (openclaw 2026.5.20 shape)", () => {
  const parsed = parseSkillsCheck(JSON.parse(FIXTURE));

  it("marks the eligible list eligible", () => {
    expect(parsed?.get("ok-skill")).toEqual({
      eligible: true,
      missing_env: [],
      missing_bins: [],
      missing_config: [],
      missing_os: [],
    });
  });

  it("maps missing env vars", () => {
    expect(parsed?.get("needs-env")).toMatchObject({
      eligible: false,
      missing_env: ["ODOO_MCP_TOKEN", "OTHER_TOKEN"],
      missing_bins: [],
    });
  });

  it("maps missing bins, folding in every anyBins alternative", () => {
    expect(parsed?.get("needs-bin")).toMatchObject({
      eligible: false,
      missing_env: [],
      missing_bins: ["definitely-not-a-bin-xyz", "nope-a", "nope-b"],
    });
  });

  it("keys by skill name (a skillKey doesn't change the name)", () => {
    expect(parsed?.get("keyed-skill")?.missing_env).toEqual(["KEYED_TOKEN"]);
  });

  it("returns null for an unknown shape", () => {
    expect(parseSkillsCheck({ skills: [] })).toBeNull();
    expect(parseSkillsCheck(null)).toBeNull();
    expect(parseSkillsCheck([])).toBeNull();
  });
});

describe("parseCheckOutput", () => {
  it("parses clean JSON stdout", () => {
    expect(parseCheckOutput(FIXTURE)?.get("ok-skill")?.eligible).toBe(true);
  });

  it("tolerates log lines before the JSON document", () => {
    expect(parseCheckOutput(`[warn] something noisy\n${FIXTURE}`)?.get("needs-env")?.eligible).toBe(false);
  });

  it("returns null for garbage", () => {
    expect(parseCheckOutput("Error: config invalid")).toBeNull();
    expect(parseCheckOutput("")).toBeNull();
  });
});
