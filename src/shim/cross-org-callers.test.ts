import { describe, expect, it } from "vitest";

import { crossOrgAgentAllowed } from "./cross-org-callers.js";

describe("crossOrgAgentAllowed", () => {
  it("admits a conversation the console opened over a cross-org binding", () => {
    expect(crossOrgAgentAllowed({ drive_through_connection_id: "dt-1", delegation_connection_id: null })).toBe(true);
    expect(crossOrgAgentAllowed({ drive_through_connection_id: null, delegation_connection_id: "conn-1" })).toBe(true);
  });

  it("refuses one with no binding, including a row read without the delegation column", () => {
    expect(crossOrgAgentAllowed({ drive_through_connection_id: null, delegation_connection_id: null })).toBe(false);
    expect(crossOrgAgentAllowed({ drive_through_connection_id: null })).toBe(false);
  });
});
