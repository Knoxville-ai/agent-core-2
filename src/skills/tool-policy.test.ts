import { describe, expect, it } from "vitest";

import {
  ALLOWLIST_ESSENTIALS,
  EMPTY_TOOL_POLICY,
  parseToolPolicy,
} from "./tool-policy.js";

describe("parseToolPolicy", () => {
  it("is empty for anything that is not a policy document", () => {
    for (const input of [null, undefined, 42, "nope", [], {}]) {
      expect(parseToolPolicy(input)).toEqual(EMPTY_TOOL_POLICY);
    }
  });

  it("adds the essentials to a non-empty allowlist", () => {
    // openclaw's allow semantics are COMPLETE: a non-empty list denies
    // everything it does not name. A console that forgot these would take away
    // exec, delegation, memory and outcome reporting — the agent would boot,
    // answer, and be unable to do anything, with no error explaining why.
    const policy = parseToolPolicy({ allow: ["exec"] });
    expect(policy.allow).toEqual(["exec", ...ALLOWLIST_ESSENTIALS]);
  });

  it("does not duplicate an essential the file already names", () => {
    const policy = parseToolPolicy({ allow: ["group:openclaw", "exec"] });
    expect(policy.allow).toEqual([
      "group:openclaw",
      "exec",
      "group:plugins",
      "knoxville_platform__*",
    ]);
  });

  it("leaves an empty allowlist empty", () => {
    // An empty allow list is fail-OPEN in openclaw (everything minus deny).
    // Injecting the essentials here would silently convert "no restriction"
    // into "only these three", which is the opposite of what it means.
    expect(parseToolPolicy({ deny: ["odoo_production__*"] }).allow).toEqual([]);
  });

  it("keeps deny, which wins over allow at the openclaw layer", () => {
    expect(parseToolPolicy({ deny: ["odoo_production__*", "group:sessions"] }).deny).toEqual(
      ["odoo_production__*", "group:sessions"],
    );
  });

  it("drops alsoAllow when allow is set, because openclaw rejects both", () => {
    const policy = parseToolPolicy({ allow: ["exec"], alsoAllow: ["odoo_production__*"] });
    expect(policy.alsoAllow).toEqual([]);
    expect(policy.allow).toContain("exec");
  });

  it("keeps alsoAllow when allow is absent", () => {
    expect(parseToolPolicy({ alsoAllow: ["odoo_production__sales_*"] })).toMatchObject({
      allow: [],
      alsoAllow: ["odoo_production__sales_*"],
    });
  });

  it("accepts the four real profiles and ignores anything else", () => {
    expect(parseToolPolicy({ profile: "minimal" }).profile).toBe("minimal");
    expect(parseToolPolicy({ profile: "coding" }).profile).toBe("coding");
    // An unknown profile would be rejected by openclaw's schema and fail the
    // boot outright, so it is dropped rather than passed through.
    expect(parseToolPolicy({ profile: "turbo" }).profile).toBeUndefined();
    expect(parseToolPolicy({ profile: 7 }).profile).toBeUndefined();
  });

  it("survives malformed entries rather than failing a boot", () => {
    const policy = parseToolPolicy({
      allow: ["exec", 42, null, "  ", "exec", " spaced "],
      deny: "not-an-array",
    });
    // Non-strings dropped, blanks dropped, duplicates collapsed, order kept.
    expect(policy.allow.slice(0, 2)).toEqual(["exec", "spaced"]);
    expect(policy.deny).toEqual([]);
  });

  it("preserves the file's ordering, which config byte-stability depends on", () => {
    const policy = parseToolPolicy({ allow: ["z_tool", "a_tool", "m_tool"] });
    expect(policy.allow.slice(0, 3)).toEqual(["z_tool", "a_tool", "m_tool"]);
  });
});
