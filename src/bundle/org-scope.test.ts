import { describe, expect, it } from "vitest";

import { scopeBundleToOrg } from "./org-scope.js";
import type { AgentBundle, BundleAssignment } from "./types.js";

function assignment(id: string, listingOrg?: Record<string, string>): BundleAssignment {
  return {
    listing: { id: `l-${id}`, slug: id, name: id, listingStatus: "live", availability: "live", ...listingOrg },
    capability: {
      id,
      name: id,
      description: "",
      actionType: "x",
      mode: "read_only",
      requiresHumanApproval: false,
      requiresUserAuth: false,
      skill: { source: "clawhub", ref: `skill-${id}`, version: "1" },
    },
  } as BundleAssignment;
}

function bundle(over: Partial<AgentBundle>): AgentBundle {
  return { agent: { uid: "a", orgId: "org1" }, assignments: [], connections: [], ...over };
}

describe("scopeBundleToOrg", () => {
  it("drops assignments whose listing declares another org (orgId or sourceOrgId)", () => {
    const out = scopeBundleToOrg(
      bundle({
        assignments: [
          assignment("own", { orgId: "org1" }),
          assignment("foreign", { orgId: "org2" }),
          assignment("foreign2", { sourceOrgId: "org3" }),
          assignment("undeclared"),
        ],
      }),
      "org1",
    );
    expect(out.assignments.map((a) => a.capability.id)).toEqual(["own", "undeclared"]);
    // The skill of a dropped entry is gone with it.
    expect(out.assignments.map((a) => a.capability.skill?.ref)).not.toContain("skill-foreign");
  });

  it("drops connections owned by another org, keeps undeclared ones", () => {
    const out = scopeBundleToOrg(
      bundle({
        connections: [
          { targetAgentUid: "t1", displayName: "a", instructions: "", orgId: "org1" },
          { targetAgentUid: "t2", displayName: "b", instructions: "", orgId: "org2" },
          { targetAgentUid: "t3", displayName: "c", instructions: "" },
        ],
      }),
      "org1",
    );
    expect(out.connections.map((c) => c.targetAgentUid)).toEqual(["t1", "t3"]);
  });

  it("leaves curated drive-thru connections alone", () => {
    const dt = [{ slug: "v", name: "V", shortDescription: "", instructions: "", agentCallPolicy: "open" as const, capabilities: [] }];
    expect(scopeBundleToOrg(bundle({ driveThroughConnections: dt }), "org1").driveThroughConnections).toEqual(dt);
  });

  it("is a no-op without an agent org or when nothing is foreign", () => {
    const b = bundle({ assignments: [assignment("x", { orgId: "org2" })] });
    expect(scopeBundleToOrg(b, "")).toBe(b);
    expect(scopeBundleToOrg(b, undefined)).toBe(b);
    const same = bundle({ assignments: [assignment("y", { orgId: "org1" })] });
    expect(scopeBundleToOrg(same, "org1")).toBe(same);
  });

  it("does not mutate the input bundle", () => {
    const b = bundle({ assignments: [assignment("x", { orgId: "org2" })] });
    scopeBundleToOrg(b, "org1");
    expect(b.assignments).toHaveLength(1);
  });
});
