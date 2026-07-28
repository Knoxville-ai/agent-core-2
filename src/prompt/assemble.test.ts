import { describe, expect, it } from "vitest";

import { assembleSystemPrompt } from "./assemble.js";
import type { AgentBundle } from "../bundle/types.js";

function bundle(over: Partial<AgentBundle> = {}): AgentBundle {
  return {
    agent: { uid: "a".repeat(16), orgId: "org1" },
    assignments: [],
    connections: [],
    ...over,
  };
}

function capabilityAssignment(over: Record<string, unknown> = {}) {
  return {
    listing: {
      id: "l1",
      slug: "odoo",
      name: "Odoo",
      listingStatus: "live",
      availability: "live",
    },
    capability: {
      id: "cap1",
      name: "Place purchase order",
      description: "Create and confirm a PO",
      actionType: "purchase_order.create",
      mode: "transactional" as const,
      requiresHumanApproval: false,
      requiresUserAuth: false,
      promptFragment: "Use this to place a PO with a vendor.",
      ...over,
    },
  };
}

describe("assembleSystemPrompt — approval-gated capabilities (0048)", () => {
  it("renders the escalate_to_human approval instruction for a gated capability", () => {
    const out = assembleSystemPrompt({
      constitution: "BASE",
      identity: "ID",
      bundle: bundle({
        assignments: [capabilityAssignment({ requiresHumanApproval: true })],
      }),
    });
    expect(out).toContain("## Capability: Place purchase order");
    expect(out).toContain("Human approval required");
    expect(out).toContain("escalate_to_human");
    expect(out).toContain('kind: "approval"');
  });

  it("still renders a gated capability that has no prompt fragment", () => {
    const out = assembleSystemPrompt({
      constitution: "BASE",
      identity: "ID",
      bundle: bundle({
        assignments: [
          capabilityAssignment({ requiresHumanApproval: true, promptFragment: null }),
        ],
      }),
    });
    expect(out).toContain("## Capability: Place purchase order");
    expect(out).toContain("Human approval required");
  });

  it("adds no approval instruction when the capability is not gated", () => {
    const out = assembleSystemPrompt({
      constitution: "BASE",
      identity: "ID",
      bundle: bundle({
        assignments: [capabilityAssignment({ requiresHumanApproval: false })],
      }),
    });
    expect(out).toContain("## Capability: Place purchase order");
    expect(out).not.toContain("Human approval required");
  });
});

describe("assembleSystemPrompt — DELEGATION", () => {
  it("omits the DELEGATION section when there are no connections", () => {
    const out = assembleSystemPrompt({
      constitution: "BASE",
      identity: "ID",
      bundle: bundle(),
    });
    expect(out).not.toContain("# DELEGATION");
  });

  it("renders a connection with its target uid, label, and instructions", () => {
    const target = "b".repeat(16);
    const out = assembleSystemPrompt({
      constitution: "BASE",
      identity: "ID",
      bundle: bundle({
        connections: [
          {
            targetAgentUid: target,
            displayName: "Purchasing",
            label: "pricing",
            instructions:
              "Ask for live price + inventory of a blank by style/color/size.",
          },
        ],
      }),
    });
    expect(out).toContain("# DELEGATION");
    expect(out).toContain("## Connection: Purchasing (pricing)");
    expect(out).toContain(`target agent uid: ${target}`);
    expect(out).toContain("live price + inventory");
    // The section teaches the call recipe.
    expect(out).toContain("start_agent_conversation");
  });

  it("falls back to a placeholder when instructions are blank", () => {
    const out = assembleSystemPrompt({
      constitution: "BASE",
      identity: "ID",
      bundle: bundle({
        connections: [
          {
            targetAgentUid: "c".repeat(16),
            displayName: "Inventory",
            instructions: "   ",
          },
        ],
      }),
    });
    expect(out).toContain("## Connection: Inventory");
    expect(out).toContain("_No usage instructions provided._");
  });

  it("renders a curated drive-thru connection with its capabilities and call recipe", () => {
    const out = assembleSystemPrompt({
      constitution: "BASE",
      identity: "ID",
      bundle: bundle({
        driveThroughConnections: [
          {
            slug: "vendor-x",
            name: "Vendor X",
            shortDescription: "Blank apparel supplier",
            instructions: "Use for restock POs and delivery issues.",
            agentCallPolicy: "authenticated",
            capabilities: [
              { name: "Order Placement", description: "Submit a purchase order", actionType: "order" },
              { name: "Customer Service", description: "Delivery + returns", actionType: "support" },
            ],
          },
        ],
      }),
    });
    expect(out).toContain("# DELEGATION");
    expect(out).toContain("## Drive-thru: Vendor X");
    expect(out).toContain("slug: vendor-x");
    expect(out).toContain("Order Placement");
    expect(out).toContain("Customer Service");
    // Drive-thrus are reached via start_conversation(slug, capability), not the
    // agent-uid delegation recipe.
    expect(out).toContain("start_conversation");
    expect(out).toContain("`capability`");
  });

  it("restricts to listed connections when open discovery is off", () => {
    const out = assembleSystemPrompt({
      constitution: "BASE",
      identity: "ID",
      bundle: bundle({
        allowOpenDiscovery: false,
        driveThroughConnections: [
          {
            slug: "vendor-x",
            name: "Vendor X",
            shortDescription: "",
            instructions: "",
            agentCallPolicy: "open",
            capabilities: [{ name: "General", description: "", actionType: "chat" }],
          },
        ],
      }),
    });
    expect(out).toContain("do not search for or call drive-thrus that are not");
    expect(out).not.toContain("you may discover one with");
  });

  it("permits open discovery when the flag is on", () => {
    const out = assembleSystemPrompt({
      constitution: "BASE",
      identity: "ID",
      bundle: bundle({ allowOpenDiscovery: true }),
    });
    expect(out).toContain("# DELEGATION");
    expect(out).toContain("search_drive_throughs");
  });
});
