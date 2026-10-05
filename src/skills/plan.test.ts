import { afterEach, describe, expect, it, vi } from "vitest";

import { BundleClient, type ToolCallResult } from "../bundle/client.js";
import { McpSkillSyncPlatform, PlanShapeError, parseSyncPlan, type ToolCaller } from "./plan.js";

function caller(fn: (name: string, args: unknown) => Promise<ToolCallResult>): ToolCaller & {
  calls: Array<{ name: string; args: unknown }>;
} {
  const calls: Array<{ name: string; args: unknown }> = [];
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      return fn(name, args);
    },
  };
}

describe("McpSkillSyncPlatform.getSkillSyncPlan", () => {
  it("sends the request as get_skill_sync_plan arguments and returns the plan", async () => {
    const c = caller(async () => ({ structuredContent: { generation: 4, skills: [] } }));
    const out = await new McpSkillSyncPlatform(c).getSkillSyncPlan({ if_generation: 3, installed: { a: "x" } });
    expect(c.calls).toEqual([{ name: "get_skill_sync_plan", args: { if_generation: 3, installed: { a: "x" } } }]);
    expect(out).toEqual({ kind: "plan", plan: { generation: 4, skills: [] } });
  });

  it("an older console's `Unknown tool` error means: use the legacy path", async () => {
    const c = caller(async () => ({
      isError: true,
      content: [{ type: "text", text: "Unknown tool: get_skill_sync_plan" }],
    }));
    const out = await new McpSkillSyncPlatform(c).getSkillSyncPlan({});
    expect(out.kind).toBe("legacy");
  });

  it("also recognizes Unknown tool raised at the JSON-RPC layer", async () => {
    const c = caller(async () => {
      throw new Error("platform MCP error -32602: Unknown tool: get_skill_sync_plan");
    });
    expect((await new McpSkillSyncPlatform(c).getSkillSyncPlan({})).kind).toBe("legacy");
  });

  it("any other tool error is transient (throws)", async () => {
    const c = caller(async () => ({ isError: true, content: [{ type: "text", text: "database timeout" }] }));
    await expect(new McpSkillSyncPlatform(c).getSkillSyncPlan({})).rejects.toThrow(/database timeout/);
  });

  it("network failures are transient (throw)", async () => {
    const c = caller(async () => {
      throw new Error("platform MCP 503: upstream unavailable");
    });
    await expect(new McpSkillSyncPlatform(c).getSkillSyncPlan({})).rejects.toThrow(/503/);
  });

  it("a malformed plan is transient (throws PlanShapeError)", async () => {
    const c = caller(async () => ({ structuredContent: { skills: [] } }));
    await expect(new McpSkillSyncPlatform(c).getSkillSyncPlan({})).rejects.toBeInstanceOf(PlanShapeError);
  });
});

describe("McpSkillSyncPlatform.reportSkillSync", () => {
  it("is best effort: errors are swallowed", async () => {
    const throwing = caller(async () => {
      throw new Error("down");
    });
    await expect(
      new McpSkillSyncPlatform(throwing).reportSkillSync({ generation: 1, results: [] }),
    ).resolves.toBeUndefined();
    const rejecting = caller(async () => ({ isError: true, content: [{ type: "text", text: "nope" }] }));
    await expect(
      new McpSkillSyncPlatform(rejecting).reportSkillSync({ generation: 1, results: [] }),
    ).resolves.toBeUndefined();
    expect(rejecting.calls[0]?.name).toBe("report_skill_sync");
  });
});

describe("parseSyncPlan", () => {
  it("passes `unchanged` through with nothing else", () => {
    expect(parseSyncPlan({ generation: 9, unchanged: true, skills: [{}] })).toEqual({
      generation: 9,
      unchanged: true,
    });
  });

  it("normalizes skills, legacy entries and files", () => {
    const plan = parseSyncPlan({
      generation: 2,
      skills: [
        {
          slug: "a",
          skill_id: "s",
          version_id: "v",
          version: "1.0.0",
          content_sha256: "c",
          managed_by: "capability",
          required: true,
          skill_key: null,
          requirements: { env: ["X"] },
          files: [{ path: "SKILL.md", sha256: "h", size: 3, executable: false, url: "https://u" }],
        },
      ],
      legacy: [{ slug: "old", version: null, required: true }],
    });
    expect(plan.skills?.[0]).toMatchObject({
      slug: "a",
      managed_by: "capability",
      required: true,
      requirements: { env: ["X"], bins: [], uv: [] },
      files: [{ path: "SKILL.md", sha256: "h", size: 3, executable: false, url: "https://u" }],
    });
    expect(plan.legacy).toEqual([{ slug: "old", version: null, required: true }]);
  });

  it("rejects plans without a generation or with unidentifiable skills", () => {
    expect(() => parseSyncPlan(null)).toThrow(PlanShapeError);
    expect(() => parseSyncPlan({ skills: [] })).toThrow(PlanShapeError);
    expect(() => parseSyncPlan({ generation: 1, skills: [{ content_sha256: "c" }] })).toThrow(/slug/);
    expect(() => parseSyncPlan({ generation: 1, skills: "nope" })).toThrow(PlanShapeError);
  });
});

describe("BundleClient.callTool (transport)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs a JSON-RPC tools/call with the agent bearer and returns the raw result", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "Unknown tool: x" }] } }),
        { status: 200 },
      ),
    );
    const client = new BundleClient({ url: "https://mcp.example/api", token: "knox_agent_t" });
    const result = await client.callTool("get_skill_sync_plan", { installed: {} });
    expect(result.isError).toBe(true);
    const [, init] = spy.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer knox_agent_t" });
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      method: "tools/call",
      params: { name: "get_skill_sync_plan", arguments: { installed: {} } },
    });
  });
});
