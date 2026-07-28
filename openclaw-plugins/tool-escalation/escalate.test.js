import { describe, expect, it } from "vitest";

import {
  buildApprovalResult,
  decideForTool,
  parseEscalateList,
  PLUGIN_ID,
  shouldEscalate,
} from "./escalate.js";

describe("parseEscalateList", () => {
  it("splits on commas, whitespace, and newlines and de-dupes", () => {
    const set = parseEscalateList("a__x, a__y a__x\nb__z");
    expect([...set].sort()).toEqual(["a__x", "a__y", "b__z"]);
  });

  it("is empty for missing / blank / non-string input", () => {
    expect(parseEscalateList(undefined).size).toBe(0);
    expect(parseEscalateList("").size).toBe(0);
    expect(parseEscalateList("   ").size).toBe(0);
    expect(parseEscalateList(null).size).toBe(0);
    expect(parseEscalateList(42).size).toBe(0);
  });
});

describe("shouldEscalate", () => {
  const set = new Set(["odoo_production__ap_get_purchase_order"]);
  it("true only for a flagged tool name", () => {
    expect(shouldEscalate("odoo_production__ap_get_purchase_order", set)).toBe(true);
    expect(shouldEscalate("odoo_production__sales_get_order", set)).toBe(false);
    expect(shouldEscalate("", set)).toBe(false);
    expect(shouldEscalate(undefined, set)).toBe(false);
    expect(shouldEscalate(null, set)).toBe(false);
  });
});

describe("buildApprovalResult", () => {
  it("returns a fail-closed, once-or-deny requireApproval for the tool", () => {
    const r = buildApprovalResult("odoo_production__sales_confirm_order");
    expect(r.requireApproval.title).toContain("odoo_production__sales_confirm_order");
    expect(r.requireApproval.severity).toBe("critical");
    expect(r.requireApproval.timeoutBehavior).toBe("deny"); // fail-closed
    expect(r.requireApproval.allowedDecisions).toEqual(["allow-once", "deny"]);
    expect(r.requireApproval.pluginId).toBe(PLUGIN_ID);
  });
});

describe("decideForTool (the whole hook decision)", () => {
  const set = new Set(["srv__danger"]);

  it("gates a flagged tool", () => {
    const r = decideForTool("srv__danger", set);
    expect(r?.requireApproval?.title).toContain("srv__danger");
  });

  it("leaves an unflagged tool unchanged (null)", () => {
    expect(decideForTool("srv__safe", set)).toBeNull();
  });

  it("no-ops entirely when nothing is flagged", () => {
    expect(decideForTool("srv__danger", new Set())).toBeNull();
  });

  it("headline: flag one Odoo tool, gate only it", () => {
    const flagged = parseEscalateList("odoo_production__sales_confirm_order");
    expect(decideForTool("odoo_production__sales_confirm_order", flagged)).not.toBeNull();
    expect(decideForTool("odoo_production__ap_get_purchase_order", flagged)).toBeNull();
  });
});
