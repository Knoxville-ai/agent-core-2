import { describe, expect, it } from "vitest";

import {
  buildOutcomeParams,
  buildStartTaskParams,
  conversationIdFromSessionKey,
  isReportOutcomeTool,
  isEscalateToHumanTool,
  conversationIdParamFor,
  isStartTaskTool,
  needsConversationId,
} from "./outcome.js";

describe("conversationIdParamFor", () => {
  it("uses conversation_id for the tools that act ON a session", () => {
    expect(conversationIdParamFor("report_outcome")).toBe("conversation_id");
    expect(conversationIdParamFor("knoxville_platform__start_task")).toBe(
      "conversation_id",
    );
    // escalate_to_human parks the session it names (0048), so it takes the same
    // conversation_id the runtime stamps for report_outcome.
    expect(conversationIdParamFor("knoxville_platform__escalate_to_human")).toBe(
      "conversation_id",
    );
  });

  it("uses caller_conversation_id for the tools that OPEN a session", () => {
    // Those two already RETURN a conversation_id (the new one), so taking one
    // as input under the same name would be ambiguous.
    expect(conversationIdParamFor("start_conversation")).toBe(
      "caller_conversation_id",
    );
    expect(
      conversationIdParamFor("knoxville_platform__start_agent_conversation"),
    ).toBe("caller_conversation_id");
  });

  it("returns null for everything else", () => {
    for (const name of ["exec", "send_message", "recall", "wait_for_task", null]) {
      expect(conversationIdParamFor(name), String(name)).toBeNull();
    }
  });
});

describe("buildOutcomeParams with an explicit param name", () => {
  it("stamps under the requested key", () => {
    expect(
      buildOutcomeParams({ slug: "sanmar" }, "conv-1", "caller_conversation_id"),
    ).toEqual({ slug: "sanmar", caller_conversation_id: "conv-1" });
  });

  it("no-ops when that key is already correct", () => {
    expect(
      buildOutcomeParams(
        { caller_conversation_id: "conv-1" },
        "conv-1",
        "caller_conversation_id",
      ),
    ).toBeNull();
  });
});

describe("isEscalateToHumanTool", () => {
  it("matches the bare and server-prefixed tool name", () => {
    expect(isEscalateToHumanTool("escalate_to_human")).toBe(true);
    expect(isEscalateToHumanTool("knoxville_platform.escalate_to_human")).toBe(true);
    expect(isEscalateToHumanTool("knoxville_platform__escalate_to_human")).toBe(true);
  });

  it("does not match neighbouring tools", () => {
    for (const name of ["report_outcome", "start_task", "send_message", null]) {
      expect(isEscalateToHumanTool(name), String(name)).toBe(false);
    }
  });
});

describe("isStartTaskTool", () => {
  it("matches the bare and server-prefixed tool name", () => {
    expect(isStartTaskTool("start_task")).toBe(true);
    expect(isStartTaskTool("knoxville_platform.start_task")).toBe(true);
    expect(isStartTaskTool("knoxville_platform:start_task")).toBe(true);
    expect(isStartTaskTool("knoxville_platform__start_task")).toBe(true);
  });

  it("does not match neighbouring task tools", () => {
    for (const name of [
      "wait_for_task",
      "get_task_result",
      "cancel_task",
      "report_task_progress",
      "start_tasks",
    ]) {
      expect(isStartTaskTool(name), name).toBe(false);
    }
  });
});

describe("needsConversationId", () => {
  it("covers both tools that require a runtime-supplied conversation id", () => {
    expect(needsConversationId("report_outcome")).toBe(true);
    expect(needsConversationId("start_task")).toBe(true);
  });

  it("leaves every other tool alone", () => {
    for (const name of ["exec", "send_message", "wait_for_task", "recall"]) {
      expect(needsConversationId(name), name).toBe(false);
    }
  });
});

describe("buildStartTaskParams", () => {
  it("stamps the caller's conversation id so the task gets a card and a callback", () => {
    // Without this the task still runs, but parent_conversation_id is null:
    // no card in the thread and nobody is ever woken with the result. That was
    // a real failure in the field, not a hypothetical.
    const out = buildStartTaskParams(
      { slug: "sanmar", instructions: "check inventory" },
      "conv-1",
    );
    expect(out).toEqual({
      slug: "sanmar",
      instructions: "check inventory",
      conversation_id: "conv-1",
    });
  });

  it("overrides a conversation id the model invented", () => {
    const out = buildStartTaskParams(
      { instructions: "x", conversation_id: "guessed" },
      "conv-1",
    );
    expect(out.conversation_id).toBe("conv-1");
  });

  it("leaves the call unchanged from a task session (a sub-task has no conversation)", () => {
    expect(
      buildStartTaskParams({ instructions: "x" }, conversationIdFromSessionKey("task:t-1")),
    ).toBeNull();
  });
});

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

  it("returns null for a task session — a task id is not a conversation id", () => {
    // A long-running task executor runs under `task:<taskId>` (console 0047).
    // Reading the suffix as a conversation id would send the platform a close
    // for a conversation that does not exist; a task reports its terminal state
    // through the task callback API instead.
    expect(conversationIdFromSessionKey("task:11111111-2222-3333")).toBeNull();
    expect(conversationIdFromSessionKey("task:")).toBeNull();
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
