import { describe, expect, it } from "vitest";

import {
  buildProgressParams,
  isReportProgressTool,
  taskIdFromSessionKey,
} from "./progress.js";

describe("isReportProgressTool", () => {
  it("matches the bare tool name", () => {
    expect(isReportProgressTool("report_task_progress")).toBe(true);
  });

  it("matches the common MCP namespacings", () => {
    for (const name of [
      "knoxville_platform.report_task_progress",
      "knoxville_platform:report_task_progress",
      "knoxville_platform__report_task_progress",
      "mcp/report_task_progress",
    ]) {
      expect(isReportProgressTool(name), name).toBe(true);
    }
  });

  it("does not match unrelated tools", () => {
    for (const name of [
      "report_outcome",
      "report_task_progress_v2",
      "exec",
      "",
      undefined,
      null,
      42,
    ]) {
      expect(isReportProgressTool(name), String(name)).toBe(false);
    }
  });
});

describe("taskIdFromSessionKey", () => {
  it("reads the id out of a task session key", () => {
    expect(taskIdFromSessionKey("task:abc-123")).toBe("abc-123");
  });

  it("returns null for chat sessions, so a conversation id is never mistaken for a task", () => {
    expect(taskIdFromSessionKey("webchat:conv-1")).toBeNull();
    expect(taskIdFromSessionKey("a2a:conv-1")).toBeNull();
  });

  it("returns null for unreadable keys", () => {
    for (const key of ["", "task:", "task:   ", "nocolon", undefined, null, 7]) {
      expect(taskIdFromSessionKey(key), String(key)).toBeNull();
    }
  });
});

describe("buildProgressParams", () => {
  it("stamps the task id onto a copy of the params", () => {
    const params = { note: "halfway" };
    const out = buildProgressParams(params, "t-1");
    expect(out).toEqual({ note: "halfway", task_id: "t-1" });
    expect(params).toEqual({ note: "halfway" }); // input untouched
  });

  it("overrides an id the model tried to supply — the runtime is authoritative", () => {
    const out = buildProgressParams(
      { note: "halfway", task_id: "hallucinated" },
      "t-1",
    );
    expect(out).toEqual({ note: "halfway", task_id: "t-1" });
  });

  it("returns null when already correct, so the hook is a no-op", () => {
    expect(buildProgressParams({ note: "x", task_id: "t-1" }, "t-1")).toBeNull();
  });

  it("returns null without a usable task id", () => {
    expect(buildProgressParams({ note: "x" }, "")).toBeNull();
    expect(buildProgressParams({ note: "x" }, null)).toBeNull();
  });

  it("tolerates a non-object params value", () => {
    expect(buildProgressParams(null, "t-1")).toEqual({ task_id: "t-1" });
    expect(buildProgressParams("nope", "t-1")).toEqual({ task_id: "t-1" });
  });
});
