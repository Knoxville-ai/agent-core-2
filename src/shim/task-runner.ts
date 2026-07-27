import { join } from "node:path";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import type { MemoryCheckpoint } from "../provision/agent-memory.js";
import type { DelegatedCredentialStore } from "./delegated-credentials.js";
import { credentialKeyNames } from "./delegated-credentials.js";
import { resolveCapabilities } from "./model-capabilities.js";
import {
  buildTokenUsage,
  fetchDelegatedCredentialsForTurn,
  historyToOpenaiMessages,
  iterOpenaiDeltas,
  type OpenaiUsage,
} from "./routes-messages.js";
import type { AttachmentRow, MessagingDB } from "./supabase-db.js";
import { TaskReporter } from "./task-reporter.js";

/**
 * The long-running task executor (console migration 0047).
 *
 * A task is a model turn that has been decoupled from any HTTP request. The
 * shim 202s the start immediately and runs the work here, in the background,
 * for as long as it takes — minutes or hours. Nothing upstream is holding a
 * connection, so no function ceiling, edge idle timeout, or client disconnect
 * can kill it. Progress and the final result travel back over the platform's
 * task callback API (see task-reporter.ts).
 *
 * ── Two lanes, and why ────────────────────────────────────────────────────
 *
 * Ordinary tasks run up to AGENT_MAX_CONCURRENT_TASKS at a time.
 *
 * DELEGATED tasks — the ones carrying credentials another agent shared — run
 * strictly ONE at a time, in their own lane. That is not a throughput
 * preference, it is a correctness requirement, and it is worth being precise
 * about because it is the least obvious constraint in this system:
 *
 *   The credentials for a delegated turn are injected into the skill's exec
 *   environment. On the chat-completions path openclaw does not fire
 *   `before_tool_call` hooks and does not expose the session key to the exec
 *   subprocess, so the only working injection point is the exec shim
 *   (docker/knox-python3-shim.py), which asks the store for "the credentials of
 *   the single live delegated turn" (DelegatedCredentialStore.currentSingle).
 *   That method deliberately returns NOTHING when two delegated turns overlap —
 *   fail-closed, so one caller's secret can never reach another's skill.
 *
 * With synchronous turns that overlap window was seconds and collisions were
 * rare. An hour-long delegated task would make them the norm, and the symptom
 * would be silent: skills would start reporting auth errors for no visible
 * reason. Serializing the credential lane keeps `currentSingle` correct by
 * construction for task-vs-task overlap.
 *
 * What this does NOT solve: a delegated *message* turn arriving while a
 * delegated task is running still overlaps, and still fails closed. That is the
 * pre-existing behavior, now logged loudly (see the store's currentSingle) so it
 * is diagnosable rather than mysterious. Fixing it properly needs openclaw to
 * expose the session key to exec subprocesses.
 */

export interface TaskSpec {
  taskId: string;
  instructions: string;
  title: string | null;
  /** The conversation the work runs in. Also the credential scope. */
  conversationId: string | null;
  callbackUrl: string;
  callbackToken: string;
  deadlineAt: string | null;
  /** Platform's view of whether this task's turns are delegated. */
  delegated: boolean;
}

export type TaskState = "queued" | "running" | "finished";

interface TrackedTask {
  spec: TaskSpec;
  state: TaskState;
  abort: AbortController;
  startedAt: number;
  /** True when this task holds (or wants) the serialized credential lane. */
  usesCredentialLane: boolean;
}

export interface TaskRunnerDeps {
  env: AgentEnv;
  db: MessagingDB;
  memory: MemoryCheckpoint;
  delegatedCreds: DelegatedCredentialStore;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export class TaskRunner {
  private readonly deps: TaskRunnerDeps;
  private readonly tasks = new Map<string, TrackedTask>();
  private readonly queue: string[] = [];
  private generalRunning = 0;
  private credentialLaneBusy = false;

  constructor(deps: TaskRunnerDeps) {
    this.deps = deps;
  }

  /** Tasks accepted and not yet finished. */
  get activeCount(): number {
    let n = 0;
    for (const t of this.tasks.values()) if (t.state !== "finished") n += 1;
    return n;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  snapshot(): Array<{
    task_id: string;
    state: TaskState;
    delegated: boolean;
    started_at: number;
  }> {
    return [...this.tasks.values()].map((t) => ({
      task_id: t.spec.taskId,
      state: t.state,
      delegated: t.usesCredentialLane,
      started_at: t.startedAt,
    }));
  }

  /**
   * Accept a task. Returns false when the queue is full — the platform turns
   * that into a failed start, which is far better than silently sitting on work
   * nobody is going to do.
   */
  accept(spec: TaskSpec): boolean {
    if (this.tasks.has(spec.taskId)) return true; // idempotent re-delivery
    if (this.queue.length >= this.deps.env.AGENT_MAX_QUEUED_TASKS) return false;

    this.tasks.set(spec.taskId, {
      spec,
      state: "queued",
      abort: new AbortController(),
      startedAt: Date.now(),
      usesCredentialLane: spec.delegated,
    });
    this.queue.push(spec.taskId);
    log.info("task accepted", {
      task_id: spec.taskId,
      delegated: spec.delegated,
      queued: this.queue.length,
    });
    this.pump();
    return true;
  }

  /** Ask a running task to stop. Cooperative — the turn aborts at its next
   *  stream read, then reports `cancelled`. */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.state === "finished") return false;
    task.abort.abort();
    // A task still in the queue never starts; drop it and report immediately.
    if (task.state === "queued") {
      const idx = this.queue.indexOf(taskId);
      if (idx !== -1) this.queue.splice(idx, 1);
      task.state = "finished";
      void this.reporterFor(task.spec)
        .finish({ status: "cancelled", error: "Cancelled before it started." })
        .catch(() => undefined);
      this.tasks.delete(taskId);
    }
    return true;
  }

  /** Abort everything — called on shutdown so in-flight work reports out. */
  async shutdown(): Promise<void> {
    for (const task of this.tasks.values()) {
      if (task.state !== "finished") task.abort.abort();
    }
  }

  // ── Scheduling ──────────────────────────────────────────────────────────

  /**
   * Start whatever the lanes can take. Scans the queue in order but will skip
   * past a delegated task whose lane is busy, so one long credential-carrying
   * job never blocks ordinary work behind it.
   */
  private pump(): void {
    for (let i = 0; i < this.queue.length; ) {
      const taskId = this.queue[i]!;
      const task = this.tasks.get(taskId);
      if (!task || task.state !== "queued") {
        this.queue.splice(i, 1);
        continue;
      }
      const canStart = task.usesCredentialLane
        ? !this.credentialLaneBusy
        : this.generalRunning < this.deps.env.AGENT_MAX_CONCURRENT_TASKS;
      if (!canStart) {
        i += 1;
        continue;
      }
      this.queue.splice(i, 1);
      task.state = "running";
      if (task.usesCredentialLane) this.credentialLaneBusy = true;
      else this.generalRunning += 1;
      // `run` handles its own errors, but the lane accounting must survive even
      // an unexpected throw: a leaked credential lane would stall every
      // subsequent delegated task on this vessel, silently and permanently.
      void this.run(task)
        .catch((err) => {
          log.error("task runner escaped its own error handling", {
            task_id: task.spec.taskId,
            err: String(err),
          });
        })
        .finally(() => {
          if (task.usesCredentialLane) this.credentialLaneBusy = false;
          else this.generalRunning -= 1;
          task.state = "finished";
          this.tasks.delete(task.spec.taskId);
          this.pump();
        });
    }
  }

  private reporterFor(spec: TaskSpec): TaskReporter {
    return new TaskReporter({
      taskId: spec.taskId,
      callbackUrl: spec.callbackUrl,
      callbackToken: spec.callbackToken,
      fetchImpl: this.deps.fetchImpl,
    });
  }

  // ── Execution ───────────────────────────────────────────────────────────

  private async run(task: TrackedTask): Promise<void> {
    const { env, db, delegatedCreds } = this.deps;
    const { spec } = task;
    const reporter = this.reporterFor(spec);
    const sessionKey = `task:${spec.taskId}`;

    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let cancelledByPlatform = false;

    try {
      await reporter.event("status", "Executor picked up the task.");

      // Stage this task's delegated credentials for the whole run. Same pull as
      // a delegated message turn (the platform authorizes off the conversation),
      // so an async task gets exactly the credentials its synchronous
      // equivalent would.
      if (spec.delegated && spec.conversationId) {
        const creds = await fetchDelegatedCredentialsForTurn(env, spec.conversationId);
        delegatedCreds.set(sessionKey, creds);
        if (Object.keys(creds).length > 0) {
          log.info("delegated credentials staged for task", {
            task_id: spec.taskId,
            session_key: sessionKey,
            keys: credentialKeyNames(creds),
          });
        }
      }

      // Heartbeat: proof of life, cancellation pickup, and — critically — a
      // periodic re-stage of the credentials. The store's TTL is a 10-minute
      // backstop against secrets outliving a crashed turn; a task that runs for
      // an hour would sail straight past it, so every beat refreshes the entry.
      heartbeat = setInterval(() => {
        void (async () => {
          if (spec.delegated && spec.conversationId) {
            const held = delegatedCreds.get(sessionKey);
            if (Object.keys(held).length > 0) delegatedCreds.set(sessionKey, held);
          }
          const ack = await reporter.heartbeat();
          if (ack.cancelRequested && !task.abort.signal.aborted) {
            cancelledByPlatform = true;
            log.info("task cancellation requested by platform", {
              task_id: spec.taskId,
            });
            task.abort.abort();
          }
        })();
      }, env.AGENT_TASK_HEARTBEAT_SECONDS * 1000);
      heartbeat.unref?.();

      const outcome = await this.runTurn(task, sessionKey, reporter);

      if (task.abort.signal.aborted) {
        await reporter.finish({
          status: "cancelled",
          summary: outcome.text.trim() || null,
          error: cancelledByPlatform
            ? "Cancelled on request."
            : "Cancelled by the executor.",
        });
        return;
      }

      if (outcome.error) {
        await reporter.finish({ status: "failed", error: outcome.error });
        return;
      }

      const summary = outcome.text.trim();
      await reporter.finish({
        status: "complete",
        summary: summary || "(the agent produced no output)",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("task execution threw", { task_id: spec.taskId, err: message });
      await reporter
        .finish({ status: "failed", error: message })
        .catch(() => undefined);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      // The task is over: its credentials must not outlive it.
      delegatedCreds.clear(sessionKey);
      // Checkpoint agent-owned memory now that tool-driven file writes settled —
      // same quiet point the message path uses.
      await this.deps.memory.checkpoint().catch(() => undefined);
    }
  }

  /**
   * Drive one model turn for the task and persist it into the work
   * conversation, so the task's reasoning is inspectable in the console like
   * any other session rather than vanishing into a log.
   */
  private async runTurn(
    task: TrackedTask,
    sessionKey: string,
    reporter: TaskReporter,
  ): Promise<{ text: string; error: string | null }> {
    const { env, db } = this.deps;
    const { spec } = task;
    const conversationId = spec.conversationId;

    // Without a conversation there is nothing to persist into; run the turn
    // from the instructions alone.
    let openaiMessages: Array<Record<string, unknown>>;
    let assistantMessageId: string | null = null;

    const caps = resolveCapabilities(env.LLM_PROVIDER, env.LLM_MODEL, {
      multimodal: env.LLM_MULTIMODAL,
      fileInput: env.LLM_FILE_INPUT,
    });

    if (conversationId) {
      await db.insertMessage({
        conversationId,
        role: "user",
        content: buildTaskPrompt(spec),
        status: "complete",
        senderKind: "system",
        senderId: env.AGENT_UID,
      });
      const history = await db.listMessages(conversationId);
      const attachments = await db.listAttachmentsForMessages(
        history.map((r) => r.id),
      );
      const attsByMessage = new Map<string, AttachmentRow[]>();
      for (const a of attachments) {
        const arr = attsByMessage.get(a.message_id) ?? [];
        arr.push(a);
        attsByMessage.set(a.message_id, arr);
      }
      openaiMessages = await historyToOpenaiMessages(
        history,
        attsByMessage,
        caps,
        db,
        join(env.OPENCLAW_STATE_DIR, "workspace"),
        conversationId,
      );
      assistantMessageId = await db.insertMessage({
        conversationId,
        role: "assistant",
        content: "",
        status: "streaming",
        senderKind: "agent",
        senderId: env.AGENT_UID,
      });
    } else {
      openaiMessages = [{ role: "user", content: buildTaskPrompt(spec) }];
    }

    const usageRef: { value: OpenaiUsage | null } = { value: null };
    let buffer = "";
    let error: string | null = null;
    // Narrate the first slice of output as a progress note, so a task that
    // spends a long time working shows something other than a spinner even if
    // the model never calls report_task_progress.
    let announcedFirstOutput = false;

    try {
      const upstream = await fetch(
        `http://127.0.0.1:${env.OPENCLAW_GATEWAY_PORT}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENCLAW_GATEWAY_TOKEN}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "x-openclaw-session-key": sessionKey,
          },
          body: JSON.stringify({
            model: process.env.OPENCLAW_MODEL_ROUTE ?? "openclaw/default",
            stream: true,
            stream_options: { include_usage: true },
            messages: openaiMessages,
          }),
          signal: task.abort.signal,
        },
      );

      if (!upstream.ok || !upstream.body) {
        const body = await upstream.text().catch(() => "");
        error = `gateway ${upstream.status}: ${body.slice(0, 500)}`;
      } else {
        for await (const token of iterOpenaiDeltas(upstream.body, usageRef)) {
          if (task.abort.signal.aborted) break;
          buffer += token;
          if (!announcedFirstOutput && buffer.trim().length > 40) {
            announcedFirstOutput = true;
            void reporter
              .progress(firstLine(buffer))
              .catch(() => undefined);
          }
        }
      }
    } catch (err) {
      if (!task.abort.signal.aborted) {
        error = err instanceof Error ? err.message : String(err);
      }
    }

    if (assistantMessageId && conversationId) {
      await db.updateMessage(assistantMessageId, {
        content: buffer,
        status: task.abort.signal.aborted
          ? "interrupted"
          : error
            ? "error"
            : "complete",
        completedAt: new Date().toISOString(),
        tokenUsage: buildTokenUsage(usageRef.value, env),
      });
    }

    return { text: buffer, error };
  }
}

/**
 * The turn the executor gives the model.
 *
 * Deliberately explicit about the async contract: the model is not talking to
 * anyone in real time, its final message IS the result the caller receives, and
 * progress it reports is the only thing the person waiting can see.
 */
export function buildTaskPrompt(spec: TaskSpec): string {
  const lines = [
    "You are executing a LONG-RUNNING TASK. Nobody is waiting on an open " +
      "connection, so take the time the work actually needs — minutes or hours " +
      "are fine.",
    "",
  ];
  if (spec.title) lines.push(`Task: ${spec.title}`, "");
  lines.push(spec.instructions, "");
  lines.push(
    "How this works:",
    "- Call `report_task_progress` every few minutes with one short sentence on " +
      "where you are. That note is the ONLY thing the person who asked can see " +
      "while they wait, and it is also proof of life — a task that goes silent " +
      "is eventually treated as dead and failed.",
    "- Your FINAL message is the result delivered back to the caller's session. " +
      "Write it as the answer to their request, not as a status update: what you " +
      "did, what you found, and anything they need to decide on.",
    "- If you cannot finish, say so plainly in that final message and explain " +
      "how far you got. A partial answer with its limits stated is worth much " +
      "more than an optimistic one.",
    "- Do not ask clarifying questions — there is nobody on the other end of " +
      "this turn to answer them. Make a reasonable call, state the assumption " +
      "you made, and continue.",
  );
  if (spec.deadlineAt) {
    lines.push(`- Hard deadline: ${spec.deadlineAt}. Wind down before it.`);
  }
  return lines.join("\n");
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
