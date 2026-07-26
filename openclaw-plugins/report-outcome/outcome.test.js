import { describe, expect, it } from "vitest";

import {
  buildOutcomeParams,
  conversationIdFromSessionKey,
  isReportOutcomeTool,
} from "./outcome.js";

describe("isReportOutcomeTool", () => {
  it("matches the bare and server-prefixed tool name", () => {
    expect(isReportOutcomeTool("report_outcome")).toBe(true);
    expect(isReportOutcomeTool("knoxville_platform.report_outcome")).toBe(true);
    expect(isReportOutcomeTool("knoxville_platform:report_outcome")).toBe(true);
    expect(isReportOutcomeTool("knoxville_platform__report_outcome")).toBe(true);
    expect(isReportOutcomeTool("knoxville_platform/report_outcome")).toBe(true);
  });

  it("does not match unrelated tools", () => {
    expect(isReportOutcomeTool("report_outcomes")).toBe(false);
    expect(isReportOutcomeTool("start_agent_conversation")).toBe(false);
    expect(isReportOutcomeTool("exec")).toBe(false);
    expect(isReportOutcomeTool(undefined)).toBe(false);
    expect(isReportOutcomeTool(null)).toBe(false);
  });
});

describe("conversationIdFromSessionKey", () => {
  it("strips the webchat: / a2a: prefix", () => {
    expect(conversationIdFromSessionKey("webchat:conv-1")).toBe("conv-1");
    expect(conversationIdFromSessionKey("a2a:conv-2")).toBe("conv-2");
  });

  it("returns null for a key it cannot read", () => {
    expect(conversationIdFromSessionKey("no-separator")).toBeNull();
    expect(conversationIdFromSessionKey("webchat:")).toBeNull();
    expect(conversationIdFromSessionKey("")).toBeNull();
    expect(conversationIdFromSessionKey(undefined)).toBeNull();
    expect(conversationIdFromSessionKey(null)).toBeNull();
  });
});

describe("buildOutcomeParams", () => {
  it("stamps conversation_id onto the model's params (the headline case)", () => {
    const out = buildOutcomeParams(
      { status: "success", summary: "Synced 3 orders." },
      "conv-1",
    );
    expect(out).toEqual({
      status: "success",
      summary: "Synced 3 orders.",
      conversation_id: "conv-1",
    });
  });

  it("overrides a conversation_id the model tried to supply (runtime is authoritative)", () => {
    const out = buildOutcomeParams(
      { status: "success", conversation_id: "hallucinated" },
      "conv-real",
    );
    expect(out.conversation_id).toBe("conv-real");
  });

  it("returns null when there is no id to inject", () => {
    expect(buildOutcomeParams({ status: "success" }, null)).toBeNull();
    expect(buildOutcomeParams({ status: "success" }, "")).toBeNull();
  });

  it("returns null when the id is already exactly correct (no-op)", () => {
    expect(
      buildOutcomeParams({ status: "success", conversation_id: "conv-1" }, "conv-1"),
    ).toBeNull();
  });

  it("does not mutate the input params", () => {
    const params = { status: "success" };
    buildOutcomeParams(params, "conv-1");
    expect(params).toEqual({ status: "success" });
  });
});

describe("headline: the model reports on the exact session it is serving", () => {
  it("derives the delegated conversation for an a2a turn, the own one for webchat", () => {
    // Model what the plugin does per report_outcome call: derive the id from the
    // session key, then stamp it onto the params the model emitted.
    const a2a = buildOutcomeParams(
      { status: "success", summary: "Answered the delegated question." },
      conversationIdFromSessionKey("a2a:conv-delegated"),
    );
    expect(a2a.conversation_id).toBe("conv-delegated");

    const webchat = buildOutcomeParams(
      { status: "failure", summary: "Could not reach the vendor API." },
      conversationIdFromSessionKey("webchat:conv-own"),
    );
    expect(webchat.conversation_id).toBe("conv-own");
  });
});
