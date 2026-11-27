import { describe, expect, it, vi } from "vitest";

vi.mock("./knowledge-index.js", () => ({ listKnowledgeNames: async () => [] }));

import type { AgentEnv } from "../env.js";
import type { Principal } from "./auth.js";
import { buildDynamicContext } from "./dynamic-context.js";
import type { MessagingDB } from "./supabase-db.js";

const env = { AGENT_UID: "0123456789abcdef", AGENT_ORG: "acme" } as AgentEnv;
const user: Principal = { kind: "user", userId: "u", email: null, role: null };
const advisory = { orgId: null, agentUid: null, relationship: null };

function db() {
  return {
    getCallerContext: vi.fn(async () => []),
    getRecentMemories: vi.fn(async () => [{ title: "Pricing", body: "Acme gets 20% off", kind: null, tags: null }]),
  } as unknown as MessagingDB & { getRecentMemories: ReturnType<typeof vi.fn> };
}

describe("buildDynamicContext", () => {
  it("includes recent memory by default", async () => {
    const d = db();
    const out = await buildDynamicContext(d, env, user, advisory);
    expect(out).toContain("Acme gets 20% off");
  });

  it("leaves the agent's memories out of an untrusted session (SEC-023)", async () => {
    const d = db();
    const out = await buildDynamicContext(d, env, user, advisory, { includeMemory: false });
    expect(out ?? "").not.toContain("Acme gets 20% off");
    expect(d.getRecentMemories).not.toHaveBeenCalled();
  });
});
