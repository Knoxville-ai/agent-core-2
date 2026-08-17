import { describe, expect, it, vi } from "vitest";

import { DelegatedCredentialStore } from "./delegated-credentials.js";
import {
  buildTaskPrompt,
  extractFinalAnswer,
  FINAL_ANSWER_MARKER,
  firstCompleteLine,
  isCleanFinish,
  splitModelRef,
  TaskRunner,
  type TaskSpec,
} from "./task-runner.js";
import type { AgentEnv } from "../env.js";
import type { MessagingDB } from "./supabase-db.js";
import type { MemoryCheckpoint } from "../provision/agent-memory.js";

/**
 * Scheduling tests for the task runner.
 *
 * Two properties matter here, and they pull in opposite directions:
 *
 *  1. In the DEFAULT (parallel) mode, credential-carrying tasks must run
 *     concurrently like any other. An SME agent whose whole job is accepting
 *     delegations may have a hundred live at once; serializing them would defeat
 *     the purpose. This is safe because the openclaw before_tool_call plugin
 *     injects credentials keyed by ctx.sessionKey, so each task gets its own
 *     caller's secrets.
 *
 *  2. In the SERIAL fallback mode — for a deployment where that plugin path is
 *     unavailable and the exec shim's fail-closed currentSingle() is the only
 *     injector — at most one credential-carrying task runs at a time, and
 *     ordinary tasks are still never stuck behind it.
 */

function makeEnv(overrides: Partial<AgentEnv> = {}): AgentEnv {
  return {
    AGENT_UID: "0123456789abcdef",
    AGENT_ORG: "org-1",
    OPENCLAW_STATE_DIR: "/tmp/state",
    OPENCLAW_GATEWAY_PORT: 18789,
    OPENCLAW_GATEWAY_TOKEN: "token-token-token",
    LLM_PROVIDER: "openai",
    LLM_MODEL: "gpt-4o",
    AGENT_MAX_CONCURRENT_TASKS: 2,
    AGENT_MAX_QUEUED_TASKS: 5,
    AGENT_TASK_HEARTBEAT_SECONDS: 30,
    AGENT_DELEGATED_TASK_MODE: "parallel",
    ...overrides,
  } as unknown as AgentEnv;
}

function makeSpec(
  id: string,
  delegated: boolean,
  sharesCredentials = delegated,
): TaskSpec {
  return {
    taskId: id,
    instructions: `do ${id}`,
    title: null,
    conversationId: delegated ? `conv-${id}` : null,
    callbackUrl: "https://console.test/api/tasks/" + id,
    callbackToken: "tok",
    deadlineAt: null,
    delegated,
    sharesCredentials,
    model: null,
  };
}

const serialEnv = (overrides: Partial<AgentEnv> = {}) =>
  makeEnv({ AGENT_DELEGATED_TASK_MODE: "serial", ...overrides } as Partial<AgentEnv>);

/**
 * A runner whose actual turn execution is replaced by a promise the test
 * resolves by hand, so we can observe exactly which tasks are in flight.
 */
function makeRunner(env: AgentEnv) {
  const inFlight = new Set<string>();
  const releasers = new Map<string, () => void>();

  const runner = new TaskRunner({
    env,
    db: {} as MessagingDB,
    memory: { checkpoint: async () => undefined } as unknown as MemoryCheckpoint,
    delegatedCreds: new DelegatedCredentialStore(),
  });

  // Replace the private executor. The scheduler (accept/pump/lane accounting)
  // is what we are testing; the model turn itself is exercised elsewhere.
  (runner as unknown as { run: (t: unknown) => Promise<void> }).run = (
    tracked: unknown,
  ) => {
    const spec = (tracked as { spec: TaskSpec }).spec;
    inFlight.add(spec.taskId);
    return new Promise<void>((resolve) => {
      releasers.set(spec.taskId, () => {
        inFlight.delete(spec.taskId);
        resolve();
      });
    });
  };

  const finish = async (taskId: string) => {
    releasers.get(taskId)?.();
    releasers.delete(taskId);
    // Let the .finally() chain re-enter pump().
    await new Promise((r) => setImmediate(r));
  };

  return { runner, inFlight, finish };
}

describe("TaskRunner scheduling", () => {
  it("runs ordinary tasks up to the concurrency cap", async () => {
    const { runner, inFlight, finish } = makeRunner(makeEnv());
    for (const id of ["a", "b", "c"]) runner.accept(makeSpec(id, false));
    await new Promise((r) => setImmediate(r));

    expect([...inFlight].sort()).toEqual(["a", "b"]);
    expect(runner.queuedCount).toBe(1);

    await finish("a");
    expect([...inFlight].sort()).toEqual(["b", "c"]);
  });

  it("runs delegated tasks CONCURRENTLY by default — the SME-agent case", async () => {
    // The whole point: an agent whose only job is credential-carrying delegated
    // work must not be throttled to one at a time.
    const { runner, inFlight } = makeRunner(
      makeEnv({ AGENT_MAX_CONCURRENT_TASKS: 8 } as Partial<AgentEnv>),
    );
    for (const id of ["d1", "d2", "d3", "d4", "d5"]) {
      runner.accept(makeSpec(id, true));
    }
    await new Promise((r) => setImmediate(r));

    expect([...inFlight].sort()).toEqual(["d1", "d2", "d3", "d4", "d5"]);
    expect(runner.queuedCount).toBe(0);
  });

  it("still honours the general cap for delegated tasks", async () => {
    const { runner, inFlight, finish } = makeRunner(makeEnv());
    for (const id of ["d1", "d2", "d3"]) runner.accept(makeSpec(id, true));
    await new Promise((r) => setImmediate(r));

    expect([...inFlight].sort()).toEqual(["d1", "d2"]);
    await finish("d1");
    expect([...inFlight].sort()).toEqual(["d2", "d3"]);
  });

  it("serial mode: runs at most one credential-carrying task at a time", async () => {
    const { runner, inFlight, finish } = makeRunner(
      serialEnv({ AGENT_MAX_CONCURRENT_TASKS: 8 }),
    );
    for (const id of ["d1", "d2", "d3"]) runner.accept(makeSpec(id, true));
    await new Promise((r) => setImmediate(r));

    expect([...inFlight]).toEqual(["d1"]);
    expect(runner.queuedCount).toBe(2);

    await finish("d1");
    expect([...inFlight]).toEqual(["d2"]);

    await finish("d2");
    expect([...inFlight]).toEqual(["d3"]);
  });

  it("serial mode: a delegation that shares nothing is not serialized", async () => {
    // No credentials means nothing can collide in the store, so there is no
    // reason to make these queue.
    const { runner, inFlight } = makeRunner(
      serialEnv({ AGENT_MAX_CONCURRENT_TASKS: 8 }),
    );
    for (const id of ["d1", "d2", "d3"]) {
      runner.accept(makeSpec(id, true, false));
    }
    await new Promise((r) => setImmediate(r));

    expect([...inFlight].sort()).toEqual(["d1", "d2", "d3"]);
  });

  it("serial mode: a long delegated task never blocks ordinary work", async () => {
    const { runner, inFlight, finish } = makeRunner(serialEnv());
    // Two delegated tasks queued first, then ordinary ones. The second
    // delegated task cannot start, but the ordinary tasks must not wait on it.
    runner.accept(makeSpec("d1", true));
    runner.accept(makeSpec("d2", true));
    runner.accept(makeSpec("n1", false));
    runner.accept(makeSpec("n2", false));
    await new Promise((r) => setImmediate(r));

    expect([...inFlight].sort()).toEqual(["d1", "n1", "n2"]);
    expect(runner.queuedCount).toBe(1); // d2 still waiting on the credential lane

    await finish("d1");
    expect([...inFlight].sort()).toEqual(["d2", "n1", "n2"]);
  });

  it("serial mode: frees the credential lane when a delegated task throws", async () => {
    const env = serialEnv();
    const runner = new TaskRunner({
      env,
      db: {} as MessagingDB,
      memory: { checkpoint: async () => undefined } as unknown as MemoryCheckpoint,
      delegatedCreds: new DelegatedCredentialStore(),
    });
    const seen: string[] = [];
    (runner as unknown as { run: (t: unknown) => Promise<void> }).run = async (
      tracked: unknown,
    ) => {
      const spec = (tracked as { spec: TaskSpec }).spec;
      seen.push(spec.taskId);
      throw new Error("boom");
    };

    runner.accept(makeSpec("d1", true));
    runner.accept(makeSpec("d2", true));
    await new Promise((r) => setImmediate(r));

    expect(seen).toEqual(["d1", "d2"]);
  });

  it("rejects a start once the queue is full rather than sitting on the work", () => {
    const { runner } = makeRunner(
      makeEnv({ AGENT_MAX_CONCURRENT_TASKS: 1, AGENT_MAX_QUEUED_TASKS: 2 } as Partial<AgentEnv>),
    );
    expect(runner.accept(makeSpec("a", false))).toBe(true);
    expect(runner.accept(makeSpec("b", false))).toBe(true);
    expect(runner.accept(makeSpec("c", false))).toBe(true);
    // Queue is now at its limit; the next start must be refused so the platform
    // fails it loudly instead of the vessel quietly hoarding it.
    expect(runner.accept(makeSpec("d", false))).toBe(false);
  });

  it("is idempotent on a re-delivered task id", () => {
    const { runner } = makeRunner(makeEnv());
    expect(runner.accept(makeSpec("a", false))).toBe(true);
    expect(runner.accept(makeSpec("a", false))).toBe(true);
    expect(runner.activeCount).toBe(1);
  });

  it("drops a queued task on cancel without ever starting it", async () => {
    const { runner, inFlight } = makeRunner(
      makeEnv({ AGENT_MAX_CONCURRENT_TASKS: 1 } as Partial<AgentEnv>),
    );
    runner.accept(makeSpec("a", false));
    runner.accept(makeSpec("b", false));
    await new Promise((r) => setImmediate(r));
    expect([...inFlight]).toEqual(["a"]);

    expect(runner.cancel("b")).toBe(true);
    expect(runner.queuedCount).toBe(0);
    expect(inFlight.has("b")).toBe(false);
  });
});

describe("buildTaskPrompt", () => {
  it("tells the model its final message is the deliverable", () => {
    const prompt = buildTaskPrompt(makeSpec("a", false));
    expect(prompt).toContain("LONG-RUNNING TASK");
    expect(prompt).toContain("FINAL message is the result");
    expect(prompt).toContain("report_task_progress");
  });

  it("tells the model not to ask questions nobody can answer", () => {
    expect(buildTaskPrompt(makeSpec("a", false))).toContain(
      "Do not ask clarifying questions",
    );
  });

  it("includes the deadline when there is one", () => {
    const spec = { ...makeSpec("a", false), deadlineAt: "2026-01-01T00:00:00Z" };
    expect(buildTaskPrompt(spec)).toContain("2026-01-01T00:00:00Z");
  });

  it("asks for the final-answer marker and forbids report_outcome", () => {
    const prompt = buildTaskPrompt(makeSpec("a", false));
    expect(prompt).toContain(FINAL_ANSWER_MARKER);
    expect(prompt).toContain("Do NOT call `report_outcome`");
  });

  it("requires narration before each tool call (stream keepalive + visibility)", () => {
    // A long silent stretch of tool calls is what let the gateway stream go idle
    // past undici's body timeout; the model narrating between calls is the soft
    // backstop to the dispatcher fix, and doubles as live visibility.
    const prompt = buildTaskPrompt(makeSpec("a", false));
    expect(prompt).toContain("BEFORE each tool call");
    expect(prompt).toContain("never the final answer");
  });
});

describe("extractFinalAnswer", () => {
  it("returns only what follows the marker, hasMarker true", () => {
    // openclaw's chat-completions stream concatenates every assistant turn, so
    // the raw buffer is the model thinking out loud. Only the tail is the answer.
    const raw = [
      "Let me check the skill first.",
      "I see the issue — PC54 doesn't have a \"Black\" color, but \"Jet Black\".",
      FINAL_ANSWER_MARKER,
      "PC54 Jet Black L: 412 units across 3 warehouses.",
    ].join("\n");
    expect(extractFinalAnswer(raw)).toEqual({
      answer: "PC54 Jet Black L: 412 units across 3 warehouses.",
      hasMarker: true,
    });
  });

  it("uses the LAST marker when the model emits more than one", () => {
    const raw = `first\n${FINAL_ANSWER_MARKER}\nnot this\n${FINAL_ANSWER_MARKER}\nthis one`;
    expect(extractFinalAnswer(raw)).toEqual({ answer: "this one", hasMarker: true });
  });

  it("reports hasMarker=false when the model never emits the marker, so run() fails the task", () => {
    // The observed poison-pill symptom: a run stops after a tool errored, the
    // buffer holds only progress notes, and no ===TASK RESULT=== was ever
    // emitted. The answer field still carries the raw text (so the failure
    // summary can show the tail), but hasMarker=false is the signal run() uses
    // to report the task `failed` instead of `complete`.
    expect(extractFinalAnswer("  just an answer  ")).toEqual({
      answer: "just an answer",
      hasMarker: false,
    });
  });

  it("falls back to the preceding text when the marker is last with nothing after", () => {
    // The marker was emitted, so hasMarker=true — the model reached its "I'm
    // done" step even if the deliverable line was empty.
    expect(extractFinalAnswer(`the answer\n${FINAL_ANSWER_MARKER}`)).toEqual({
      answer: "the answer",
      hasMarker: true,
    });
  });

  it("accepts the production typo: two trailing = instead of three", () => {
    // The exact incident, byte-for-byte from the stored message. A Purchasing
    // Agent task collected inventory from a sub-agent, wrote a complete answer,
    // finished cleanly — and was reported FAILED with "the model likely stalled
    // after a tool error" because it wrote `===TASK RESULT==`. One character
    // turned a delivered result into a vendor failure reported to the user.
    //
    // Note the marker is welded to the end of the preceding sentence with no
    // newline before it: that is how openclaw's concatenated stream delivers
    // it, and why the fence must not require a line START.
    const raw =
      "stock. Let me record final progress and deliver the result." +
      "===TASK RESULT==\n\n## Cutter & Buck Inventory Check";
    expect(extractFinalAnswer(raw)).toEqual({
      answer: "## Cutter & Buck Inventory Check",
      hasMarker: true,
      markerVariant: "===TASK RESULT==",
    });
  });

  it("accepts the canonical marker welded to the preceding sentence", () => {
    // The pre-existing behaviour that `lastIndexOf` gave for free and which a
    // line-anchored pattern would have silently broken for every task.
    const raw = `narration.${FINAL_ANSWER_MARKER}\nthe deliverable`;
    const got = extractFinalAnswer(raw);
    expect(got.hasMarker).toBe(true);
    expect(got.answer).toBe("the deliverable");
    expect(got.markerVariant).toBeUndefined();
  });

  it("accepts the variants that carry no meaning, and flags each as a variant", () => {
    for (const written of [
      "==TASK RESULT==",
      "====TASK RESULT====",
      "===TASK RESULT==",
      "==TASK RESULT=====",
      "===task result===",
      "===TASK  RESULT===",
      "  ===TASK RESULT===  ",
      "=== TASK RESULT ===",
    ]) {
      const got = extractFinalAnswer(`notes\n${written}\nthe deliverable`);
      expect(got.hasMarker).toBe(true);
      expect(got.answer).toBe("the deliverable");
    }
  });

  it("does not flag the canonical marker as a variant", () => {
    const got = extractFinalAnswer(`notes\n${FINAL_ANSWER_MARKER}\nanswer`);
    expect(got.markerVariant).toBeUndefined();
  });

  it("ignores the marker mentioned mid-sentence, which would truncate a real answer", () => {
    // The one false positive worth guarding: an agent explaining the protocol
    // must not have its answer cut at the explanation. The fence therefore
    // requires the words alone on their own line.
    const raw = [
      "Remember to put ===TASK RESULT=== before the final answer.",
      FINAL_ANSWER_MARKER,
      "the real deliverable",
    ].join("\n");
    expect(extractFinalAnswer(raw).answer).toBe("the real deliverable");

    const inline = "I was told to write ===TASK RESULT=== but I am still working.";
    expect(extractFinalAnswer(inline)).toEqual({
      answer: inline,
      hasMarker: false,
    });
  });

  it("still reports hasMarker=false for a single = or a missing side", () => {
    // Loose about meaningless variation, not about the shape itself.
    for (const written of ["=TASK RESULT=", "TASK RESULT", "===TASK RESULT"]) {
      expect(extractFinalAnswer(`notes\n${written}\nanswer`).hasMarker).toBe(false);
    }
  });

  it("is not affected by a previous call's regex state", () => {
    // The fence is a module-level /g regex; a leaked lastIndex would make
    // results depend on call order, which is the kind of bug that only shows
    // up in production under load.
    const raw = `notes\n${FINAL_ANSWER_MARKER}\nanswer`;
    expect(extractFinalAnswer(raw)).toEqual(extractFinalAnswer(raw));
    extractFinalAnswer("a long unrelated buffer with no marker at all");
    expect(extractFinalAnswer(raw).answer).toBe("answer");
  });
});

describe("firstCompleteLine", () => {
  it("does not publish a mid-sentence fragment", () => {
    // The production symptom: a task card whose status read
    // `I see the issue — PC54 doesn't have a "Black" color,`
    expect(firstCompleteLine('I see the issue — PC54 doesn')).toBeNull();
  });

  it("returns the opening line once it is complete", () => {
    expect(firstCompleteLine("Starting inventory lookup for 3 items.\nNext…")).toBe(
      "Starting inventory lookup for 3 items.",
    );
  });

  it("accepts a completed sentence without a newline", () => {
    expect(firstCompleteLine("Reading the skill manifest now. Then I will ")).toBe(
      "Reading the skill manifest now.",
    );
  });

  it("ignores a trivially short opening", () => {
    expect(firstCompleteLine("Ok.\n")).toBeNull();
  });

  it("truncates a very long opening line", () => {
    const line = `${"x".repeat(400)}\n`;
    expect(firstCompleteLine(line)!.length).toBe(200);
  });
});

describe("splitModelRef", () => {
  it("splits on the FIRST slash so a multi-segment OpenRouter id survives", () => {
    // This is the exact contract openclaw's parseModelRef uses for
    // x-openclaw-model: provider is everything before the first slash.
    expect(splitModelRef("openrouter/qwen/qwen3.7-plus")).toEqual({
      provider: "openrouter",
      model: "qwen/qwen3.7-plus",
    });
  });

  it("splits a simple provider/model ref", () => {
    expect(splitModelRef("anthropic/claude-opus-4-8")).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
  });

  it("returns null for a provider-less ref (caller falls back to container caps)", () => {
    expect(splitModelRef("qwen3.7-plus")).toBeNull();
  });

  it("returns null for a malformed ref with nothing on one side of the slash", () => {
    expect(splitModelRef("/model")).toBeNull();
    expect(splitModelRef("provider/")).toBeNull();
  });
});

describe("isCleanFinish", () => {
  it("a normal stop + [DONE] is a clean completion", () => {
    expect(isCleanFinish({ finishReason: "stop", sawDone: true })).toBe(true);
  });

  it("[DONE] with no finish_reason (e.g. usage-only trailer) is clean", () => {
    expect(isCleanFinish({ finishReason: null, sawDone: true })).toBe(true);
  });

  it("a definite stop is clean even if [DONE] never arrived", () => {
    expect(isCleanFinish({ finishReason: "stop", sawDone: false })).toBe(true);
  });

  it("finish_reason tool_calls is an aborted mid-tool-use run, NOT a success", () => {
    // The exact watchdog-abort signature (openclaw stopReason=toolUse): the run
    // died before the tool ran, so it must report failed, not complete.
    expect(isCleanFinish({ finishReason: "tool_calls", sawDone: true })).toBe(false);
    expect(isCleanFinish({ finishReason: "tool_calls", sawDone: false })).toBe(false);
  });

  it("a cut stream (no [DONE], no finish_reason) is incomplete", () => {
    expect(isCleanFinish({ finishReason: null, sawDone: false })).toBe(false);
  });

  it("finish_reason length (truncated at the output cap) is incomplete", () => {
    expect(isCleanFinish({ finishReason: "length", sawDone: true })).toBe(false);
  });
});
