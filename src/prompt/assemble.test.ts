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
});
