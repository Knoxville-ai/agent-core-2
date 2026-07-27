import { describe, expect, it, vi } from "vitest";

import { DelegatedCredentialStore } from "./delegated-credentials.js";
import { buildTaskPrompt, TaskRunner, type TaskSpec } from "./task-runner.js";
import type { AgentEnv } from "../env.js";
import type { MessagingDB } from "./supabase-db.js";
import type { MemoryCheckpoint } from "../provision/agent-memory.js";

/**
 * Scheduling tests for the task runner.
 *
 * The property under test is the one that is expensive to get wrong: a
 * credential-carrying (delegated) task must never run concurrently with another
 * one, because the exec shim's credential lookup is fail-closed when two
 * delegated turns overlap (see DelegatedCredentialStore.currentSingle). With
 * hour-long tasks that overlap would otherwise be routine, and the symptom —
 * skills silently losing their credentials — is very hard to trace back here.
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
    ...overrides,
  } as unknown as AgentEnv;
}

function makeSpec(id: string, delegated: boolean): TaskSpec {
  return {
    taskId: id,
    instructions: `do ${id}`,
    title: null,
    conversationId: delegated ? `conv-${id}` : null,
    callbackUrl: "https://console.test/api/tasks/" + id,
    callbackToken: "tok",
    deadlineAt: null,
    delegated,
  };
}

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

  it("runs at most one delegated task at a time, whatever the general cap is", async () => {
    const { runner, inFlight, finish } = makeRunner(
      makeEnv({ AGENT_MAX_CONCURRENT_TASKS: 8 } as Partial<AgentEnv>),
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

  it("does not let a long delegated task block ordinary work behind it", async () => {
    const { runner, inFlight, finish } = makeRunner(makeEnv());
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

  it("frees the credential lane when a delegated task throws", async () => {
    const env = makeEnv();
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
});
