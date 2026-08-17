import { join } from "node:path";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import type { MemoryCheckpoint } from "../provision/agent-memory.js";
import type { DelegatedCredentialStore } from "./delegated-credentials.js";
import { credentialKeyNames } from "./delegated-credentials.js";
import { resolveCapabilities } from "./model-capabilities.js";
import { fetchOpenclawStream } from "./openclaw-gateway-fetch.js";
import {
  buildTokenUsage,
  fetchDelegatedCredentialsForTurn,
  historyToOpenaiMessages,
  iterOpenaiDeltas,
  type OpenaiUsage,
  type StreamTermination,
} from "./routes-messages.js";
import type { AttachmentRow, MessagingDB } from "./supabase-db.js";
import { TaskReporter } from "./task-reporter.js";
import { logUsageTotals, type UsageAccumulator } from "./usage-telemetry.js";

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
 * ── Concurrency and delegated credentials ─────────────────────────────────
 *
 * Tasks run up to AGENT_MAX_CONCURRENT_TASKS at a time, INCLUDING the ones
 * carrying credentials another agent shared. That matters: an SME agent whose
 * entire job is accepting delegations and running long jobs with brokered
 * secrets may have a hundred of them live at once, each for a different caller.
 *
 * What makes that safe is that credentials are injected per SESSION, not per
 * process. Each task runs under its own `task:<taskId>` session key; the
 * openclaw `before_tool_call` plugin reads `ctx.sessionKey`, looks that session's
 * credentials up in the store, and merges them into the exec tool's `env` for
 * that one call. Concurrent tasks never see each other's secrets because they
 * never share a lookup key. Verified against openclaw 2026.5.20:
 *
 *   x-openclaw-session-key -> resolveGatewayRequestContext -> embedded runner
 *   sandboxSessionKey -> catalogToolHookContext.sessionKey -> runBeforeToolCallHook
 *   -> plugin injects params.env -> execSchema.env -> subprocess
 *
 * There is a second, weaker injector: the exec shim
 * (docker/knox-python3-shim.py), which runs inside the subprocess. openclaw gives
 * that subprocess no session key, so it can only ask for "the single live
 * delegated turn" (DelegatedCredentialStore.currentSingle) and must return
 * nothing when several overlap — fail-closed, so one caller's secret can never
 * reach another's skill, but also capped at one delegated turn at a time. The
 * plugin now stamps a marker into the env so the shim stands down when the
 * parallel-safe path already ran; the shim only matters where the plugin does
 * not fire at all.
 *
 * `AGENT_DELEGATED_TASK_MODE=serial` is the escape hatch for such a deployment:
 * it puts credential-carrying tasks back in a lane of one, so `currentSingle`
 * stays correct by construction. Ordinary tasks are never blocked behind that
 * lane in either mode.
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
  /**
   * Whether the authorizing connection actually shares at least one credential.
   *
   * Distinct from `delegated`: plenty of delegations share nothing, and those
   * tasks never touch the credential store, so in `serial` mode they have no
   * reason to queue behind the lane. Absent (older platform), we assume a
   * delegated task may carry credentials.
   */
  sharesCredentials: boolean;
  /**
   * Per-request model override for this task, as "<provider>/<model>" (e.g.
   * "openrouter/qwen/qwen3.7-plus"). Sent to the openclaw gateway as the
   * `x-openclaw-model` header, which overrides the vessel's configured
   * `model.primary` for THIS request only — so concurrent tasks on the same
   * vessel each run their own model with no shared process state. Null/absent →
   * the container default (LLM_PROVIDER/LLM_MODEL). The platform sets it from the
   * routine's (or task's) configured model; the vessel never persists it.
   */
  model?: string | null;
  /**
   * When set, this run RESUMES a task that paused on a human escalation (console
   * migration 0048): the string is the human's decision. The executor rebuilds
   * context from the work-conversation transcript (which already holds every
   * prior turn) and continues from where it left off, so nothing is lost across
   * the wait. Absent on a normal (first) task run.
   */
  resumePrompt?: string | null;
}

export type TaskState = "queued" | "running" | "finished";

interface TrackedTask {
  spec: TaskSpec;
  state: TaskState;
  abort: AbortController;
  startedAt: number;
  /** True when this task holds (or wants) the serialized credential lane.
   *  Only ever set in `serial` mode — in `parallel` mode there is no lane. */
  usesCredentialLane: boolean;
}

export interface TaskRunnerDeps {
  env: AgentEnv;
  db: MessagingDB;
  memory: MemoryCheckpoint;
  delegatedCreds: DelegatedCredentialStore;
  /** Per-task model-call / prompt-cache rollup, filled by the loopback usage
   *  ingest route and drained when the task's assistant row finalizes. */
  usage: UsageAccumulator;
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
    credential_lane: boolean;
    started_at: number;
  }> {
    return [...this.tasks.values()].map((t) => ({
      task_id: t.spec.taskId,
      state: t.state,
      delegated: t.spec.delegated,
      // Whether this task is serialized behind the credential lane — the thing
      // an operator actually wants to see when delegated throughput looks low.
      credential_lane: t.usesCredentialLane,
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

    // The serialized lane is only for a deployment that cannot use the
    // per-session plugin path, and even there only for tasks that actually
    // carry credentials — a delegation sharing nothing has nothing to collide.
    const usesCredentialLane =
      this.deps.env.AGENT_DELEGATED_TASK_MODE === "serial" &&
      spec.delegated &&
      spec.sharesCredentials;

    this.tasks.set(spec.taskId, {
      spec,
      state: "queued",
      abort: new AbortController(),
      startedAt: Date.now(),
      usesCredentialLane,
    });
    this.queue.push(spec.taskId);
    log.info("task accepted", {
      task_id: spec.taskId,
      delegated: spec.delegated,
      shares_credentials: spec.sharesCredentials,
      credential_lane: usesCredentialLane,
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
        } else {
          // A delegated task that receives NOTHING is almost always a config
          // problem — the connection exists but shares no credentials — and its
          // natural symptom is a skill failing to authenticate several minutes
          // later, deep in the task, where the real cause is invisible. Say it
          // here instead, both in the log and on the caller's task card.
          log.warn("delegated task staged NO credentials", {
            task_id: spec.taskId,
            session_key: sessionKey,
            conversation_id: spec.conversationId,
            shares_credentials_claimed: spec.sharesCredentials,
          });
          await reporter.event(
            "error",
            "This task was delegated, but the connection released no credentials. " +
              "Skills that need them will fail to authenticate. Check the " +
              "connection's shared-credential list in the console.",
          );
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

      // Distinguish a clean completion from a run openclaw aborted INTERNALLY.
      // When openclaw's stuck-session watchdog kills a stalled run, the gateway
      // stream just ends: our own abort signal is not set and no gateway error
      // is raised, so without this check the run would be reported `complete` —
      // a false success (the task closes green having produced nothing, and the
      // platform materializes a success outcome). See isCleanFinish.
      const term = outcome.terminal;
      if (!isCleanFinish(term)) {
        log.warn("task run ended without a clean completion; reporting failed", {
          task_id: spec.taskId,
          finish_reason: term.finishReason,
          saw_done: term.sawDone,
        });
        await reporter.finish({
          status: "failed",
          summary: extractFinalAnswer(outcome.text).answer || null,
          error:
            term.finishReason === "length"
              ? "The run hit the model's output limit before completing; no final result was produced."
              : "The run was interrupted before completing (stalled or aborted mid-tool-call); no final result was produced.",
        });
        return;
      }

      const final = extractFinalAnswer(outcome.text);
      if (!final.hasMarker) {
        // The prompt tells the model to put `===TASK RESULT===` immediately
        // before its deliverable. When the buffer has no marker at all, the
        // model never reached its "I'm done, here's the answer" step — it
        // stopped mid-work, most often right after a tool call errored, before
        // deciding the task was done. Reporting `complete` here writes the raw
        // narration into the outcome summary and the platform materializes a
        // success outcome, so the ledger reads green while the actual work sat
        // half-finished. Fail the task instead, keeping the tail of what the
        // model DID emit so the operator can see where it stalled.
        log.warn("task run ended without the final-answer marker; reporting failed", {
          task_id: spec.taskId,
          output_len: outcome.text.length,
        });
        const tail = final.answer.slice(-800);
        // State what was observed, and nothing more. An earlier version of this
        // message asserted the model "likely stalled after a tool error or
        // aborted mid-work" — a cause this branch has no evidence for, since a
        // clean finish with a mis-typed delimiter lands here too. That guess
        // was read as fact by the calling agent and relayed to the user as a
        // vendor failure, for work that had actually succeeded.
        await reporter.finish({
          status: "failed",
          summary: tail || null,
          error:
            `The run produced ${outcome.text.length} characters but no ` +
            `${FINAL_ANSWER_MARKER} line, so there is no way to tell which ` +
            "part was the deliverable. The summary holds the tail of what it " +
            "did emit — read that before assuming the work itself failed; a " +
            "run can finish its work and still miss the marker.",
        });
        return;
      }
      if (final.markerVariant) {
        // Accepted, but surfaced: if models drift toward a spelling we do not
        // ask for, that belongs in the logs rather than silently absorbed.
        log.warn("final-answer marker accepted in a non-canonical form", {
          task_id: spec.taskId,
          written: final.markerVariant,
          expected: FINAL_ANSWER_MARKER,
        });
      }
      await reporter.finish({
        status: "complete",
        summary: final.answer || "(the agent produced no output)",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("task execution threw", { task_id: spec.taskId, err: message });
      await reporter
        .finish({ status: "failed", error: message })
        .catch(() => undefined);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      // The task is over: its credentials must not outlive it. Cleared WITHOUT
      // a lease on purpose — the heartbeat above re-stages them on every beat,
      // so any lease captured at stage time is stale by now and a lease-checked
      // clear would silently no-op, leaving secrets resident until the TTL.
      // Safe because `task:<taskId>` is unique to this task.
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
  ): Promise<{ text: string; error: string | null; terminal: StreamTermination }> {
    const { env, db } = this.deps;
    const { spec } = task;
    const conversationId = spec.conversationId;

    // Without a conversation there is nothing to persist into; run the turn
    // from the instructions alone.
    let openaiMessages: Array<Record<string, unknown>>;
    let assistantMessageId: string | null = null;

    // Image/file-input capabilities must track the model that will ACTUALLY run
    // this turn. When the task carries a per-request model override, resolve caps
    // from that model — the env LLM_MULTIMODAL/LLM_FILE_INPUT flags describe the
    // container default, not the override, so they do not apply to it.
    const overrideRef = spec.model ? splitModelRef(spec.model) : null;
    const caps = overrideRef
      ? resolveCapabilities(overrideRef.provider, overrideRef.model)
      : resolveCapabilities(env.LLM_PROVIDER, env.LLM_MODEL, {
          multimodal: env.LLM_MULTIMODAL,
          fileInput: env.LLM_FILE_INPUT,
        });

    if (spec.model) {
      log.info("task model override applied", {
        task_id: spec.taskId,
        model: spec.model,
      });
    }

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

    // Open this task's usage bucket. Every model call openclaw makes inside the
    // agentic loop reports back through the loopback ingest route under this
    // session key; drained after the stream ends.
    this.deps.usage.begin(sessionKey);

    const usageRef: { value: OpenaiUsage | null } = { value: null };
    const terminalRef: { value: StreamTermination } = {
      value: { finishReason: null, sawDone: false },
    };
    let buffer = "";
    let error: string | null = null;
    // Narrate the first slice of output as a progress note, so a task that
    // spends a long time working shows something other than a spinner even if
    // the model never calls report_task_progress.
    let announcedFirstOutput = false;

    try {
      const upstream = await fetchOpenclawStream(
        `http://127.0.0.1:${env.OPENCLAW_GATEWAY_PORT}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENCLAW_GATEWAY_TOKEN}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "x-openclaw-session-key": sessionKey,
            // Per-request model override. openclaw applies `x-openclaw-model` over
            // its configured model.primary for THIS request only (verified against
            // openclaw 2026.5.20: openai-http resolveOpenAiCompatModelOverride →
            // buildAgentCommandInput.modelOverride, keyed by session). The body
            // `model` below stays the AGENT selector ("openclaw/default"), which is
            // a different axis. Omitted when the task has no override, so the
            // vessel default is unchanged.
            ...(spec.model ? { "x-openclaw-model": spec.model } : {}),
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
        for await (const token of iterOpenaiDeltas(upstream.body, usageRef, terminalRef)) {
          if (task.abort.signal.aborted) break;
          buffer += token;
          if (!announcedFirstOutput) {
            const opening = firstCompleteLine(buffer);
            if (opening) {
              announcedFirstOutput = true;
              void reporter.progress(opening).catch(() => undefined);
            }
          }
        }
      }
    } catch (err) {
      if (!task.abort.signal.aborted) {
        error = err instanceof Error ? err.message : String(err);
      }
    }

    // Drain this task's per-model-call rollup (prompt-cache split + loop
    // iteration count). `task:<taskId>` session keys are unique per task, so
    // unlike the webchat path this attribution is exact. Always drained, even
    // when there is no assistant row to write it onto, so the bucket cannot leak.
    const cacheTotals = this.deps.usage.drain(sessionKey);
    if (cacheTotals) logUsageTotals(sessionKey, cacheTotals);

    if (assistantMessageId && conversationId) {
      await db.updateMessage(assistantMessageId, {
        content: buffer,
        status: task.abort.signal.aborted
          ? "interrupted"
          : error
            ? "error"
            : "complete",
        completedAt: new Date().toISOString(),
        tokenUsage: buildTokenUsage(usageRef.value, env, cacheTotals),
      });
    }

    return { text: buffer, error, terminal: terminalRef.value };
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
  if (spec.resumePrompt) return buildResumePrompt(spec);
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
    "- Narrate as you work: BEFORE each tool call, emit one short plain-text line " +
      "saying what you are about to do (e.g. \"Fetching PO P13582 from Odoo\"). Do " +
      "not run a long stretch of tool calls in silence — those lines are how the " +
      "run stays visibly alive between progress reports, and how anyone watching " +
      "follows what you are doing. They are working notes, never the final answer.",
    "- Your FINAL message is the result delivered back to the caller's session. " +
      "Write it as the answer to their request, not as a status update: what you " +
      "did, what you found, and anything they need to decide on.",
    `- Put the line ${FINAL_ANSWER_MARKER} on its own immediately before that ` +
      "final answer. Everything after it is what the caller receives; everything " +
      "before it is working notes they never see. Emit it exactly once, at the end.",
    "- If you cannot finish, say so plainly in that final message and explain " +
      "how far you got. A partial answer with its limits stated is worth much " +
      "more than an optimistic one.",
    "- Do NOT call `report_outcome`. That tool closes a chat session and a task " +
      "is not one; the platform will reject the call. Finishing this turn IS how " +
      "you report — the runtime records your result the moment you stop.",
    "- Do not ask clarifying questions — there is nobody on the other end of " +
      "this turn to answer them. Make a reasonable call, state the assumption " +
      "you made, and continue.",
  );
  if (spec.deadlineAt) {
    lines.push(`- Hard deadline: ${spec.deadlineAt}. Wind down before it.`);
  }
  return lines.join("\n");
}

/**
 * The prompt for a task RESUMING after a human answered its escalation (0048).
 *
 * We deliberately do NOT re-state the original instructions: the executor loads
 * the full work-conversation transcript on every run, so all the prior turns —
 * the instructions, the work done so far, and the point where it paused — are
 * already in context above this message. This just delivers the decision and
 * says continue.
 */
function buildResumePrompt(spec: TaskSpec): string {
  return [
    "You are RESUMING a long-running task you paused earlier to escalate a " +
      "decision to a human. Your progress so far is in this conversation above — " +
      "pick up exactly where you left off; nothing has been lost.",
    "",
    "The human has answered your escalation:",
    "",
    spec.resumePrompt ?? "",
    "",
    "Apply that decision and carry the task through to completion. The same task " +
      "rules still hold:",
    "- Call `report_task_progress` every few minutes; a silent task is treated as dead.",
    "- Narrate before each tool call with one short line — no long silent tool runs.",
    "- Your FINAL message is the result delivered back to the caller.",
    `- Put ${FINAL_ANSWER_MARKER} on its own line immediately before that final answer.`,
    "- Do NOT call `report_outcome`; finishing this turn reports the result.",
    "- You may `escalate_to_human` again only if you hit a genuinely NEW blocking " +
      "decision — never to re-ask what was just answered.",
  ].join("\n");
}

/**
 * The first COMPLETE line of output, or null if none has arrived yet.
 *
 * The previous version fired at 40 characters and published whatever the model
 * happened to be mid-way through saying. In production that produced a task
 * card reading `I see the issue — PC54 doesn\'t have a "Black" color,` — a
 * truncated thought, shown to a user as the status of their work. Waiting for a
 * line break or sentence end costs nothing and never publishes a fragment.
 */
export function firstCompleteLine(text: string): string | null {
  const match = /^\s*(.+?)(?:\n|(?<=[.!?])\s)/s.exec(text);
  if (!match) return null;
  const line = match[1]!.trim();
  if (line.length < 10) return null;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** Marker the task prompt asks the model to put before its final answer. */
export const FINAL_ANSWER_MARKER = "===TASK RESULT===";

/**
 * What we ACCEPT as that marker, as opposed to what we ask for.
 *
 * Models mis-transcribe the delimiter. Observed in production: a task that had
 * already collected its data from a sub-agent, written a complete answer, and
 * finished cleanly was reported FAILED because it wrote `===TASK RESULT==` —
 * two trailing `=` instead of three. An exact `indexOf` turned a finished
 * deliverable into "the model likely stalled after a tool error", the caller
 * retried down a slower path, and the user was told the vendor lookup failed
 * when it had succeeded twice.
 *
 * So the fence is deliberately loose about everything that carries no meaning:
 * the run of `=` on either side (two or more, and the sides need not match),
 * internal spacing, and case.
 *
 * It is strict about exactly one thing — the marker must END its line. That is
 * the invariant the real data supports, and it is NOT the same as "alone on its
 * own line": openclaw's chat-completions stream concatenates every assistant
 * turn with no separator, so in production the marker arrives welded to the
 * preceding sentence — `...deliver the result.===TASK RESULT==\n\n## Report`.
 * Requiring a line start would reject the very case this exists to accept.
 *
 * Requiring the line to END there is what keeps a model *talking about* the
 * marker from matching ("Remember to put ===TASK RESULT=== before your
 * answer."), which is the only false positive worth caring about: a spurious
 * match silently truncates a real answer at the wrong place.
 *
 * `g` so we can take the LAST match, `i` for case. No `m` — the `$` in the
 * lookahead is meant as end-of-input, with `\n` handled explicitly.
 */
const FINAL_ANSWER_FENCE = /={2,}[ \t]*TASK[ \t]+RESULT[ \t]*={2,}[ \t]*(?=\r?\n|$)/gi;

/**
 * Pull the deliverable out of a task run\'s raw output.
 *
 * openclaw\'s chat-completions stream concatenates EVERY assistant turn in an
 * agentic run, so the raw buffer is the model thinking out loud: "Let me retry
 * with the correct color name.Now let me get the named warehouse breakdown..."
 * Handing that back as the task\'s summary — which is what the caller\'s agent
 * reads and relays to the user — buries the answer in narration.
 *
 * The prompt asks for a marker before the final answer; the answer is
 * everything after the LAST one. Matching is by `FINAL_ANSWER_FENCE` rather
 * than an exact string — see the note there for why a one-character
 * mis-transcription used to fail a completed task.
 *
 * `hasMarker` reports whether the model emitted a recognisable marker at all —
 * the caller uses it to decide whether the turn actually reached a deliverable
 * (see the marker-absence branch in run()). When none is present, `answer` is
 * still the full trimmed text so a failure summary can carry the tail of what
 * the model DID produce.
 */
export interface FinalAnswer {
  answer: string;
  hasMarker: boolean;
  /** The marker as the model actually wrote it, when it differs from
   *  `FINAL_ANSWER_MARKER`. Logged so drift in how models spell the fence is
   *  visible rather than silently absorbed. */
  markerVariant?: string;
}
export function extractFinalAnswer(text: string): FinalAnswer {
  const trimmed = text.trim();

  // Last match wins: the prompt asks for the marker once, but a model that
  // restates it should still have its final section taken as the answer.
  FINAL_ANSWER_FENCE.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  for (let m = FINAL_ANSWER_FENCE.exec(trimmed); m; m = FINAL_ANSWER_FENCE.exec(trimmed)) {
    last = m;
    // A zero-length match cannot happen with this pattern, but an empty match
    // would spin forever if it ever could — advance defensively.
    if (m.index === FINAL_ANSWER_FENCE.lastIndex) FINAL_ANSWER_FENCE.lastIndex++;
  }
  if (!last) return { answer: trimmed, hasMarker: false };

  const written = last[0].trim();
  const tail = trimmed.slice(last.index + last[0].length).trim();
  return {
    // A marker with nothing after it means the model emitted it and then
    // stopped; the text before it is still the best answer we have.
    answer: tail || trimmed.slice(0, last.index).trim(),
    hasMarker: true,
    ...(written === FINAL_ANSWER_MARKER ? {} : { markerVariant: written }),
  };
}

/**
 * Whether a task's model stream ended in a genuine completion — the gate for
 * reporting the task `complete` rather than `failed`.
 *
 * A clean agentic run ends with a `stop` finish and/or the `[DONE]` sentinel.
 * The failure this guards against is openclaw's stuck-session watchdog aborting
 * a stalled run: from the shim's side the gateway stream simply ends, with no
 * error and without our own abort signal set, so the run would otherwise look
 * complete and close GREEN having produced nothing. Its signatures:
 *   - finish_reason "tool_calls" — aborted mid-tool-use (openclaw's
 *     `stopReason=toolUse`); the tool never ran and no answer followed.
 *   - no `[DONE]` — the gateway stream was cut outright.
 *   - finish_reason "length" — the model was truncated at its output cap.
 * A bare `[DONE]` with no finish_reason (e.g. a usage-only trailer) is clean; a
 * definite `stop` is clean even if `[DONE]` never arrived.
 */
export function isCleanFinish(term: StreamTermination): boolean {
  if (term.finishReason === "stop") return true;
  return (
    term.sawDone &&
    term.finishReason !== "tool_calls" &&
    term.finishReason !== "length"
  );
}

/**
 * Split a "<provider>/<model>" model ref into its parts.
 *
 * Matches openclaw's own `x-openclaw-model` parsing (parseModelRef): the FIRST
 * slash separates provider from model, so a multi-segment OpenRouter id survives
 * intact — "openrouter/qwen/qwen3.7-plus" → provider "openrouter", model
 * "qwen/qwen3.7-plus". Returns null for a bare model with no provider segment
 * (openclaw would resolve that against the vessel's default provider, and we
 * cannot know the capabilities of a provider-less ref), so the caller falls back
 * to the container-default capabilities.
 */
export function splitModelRef(
  ref: string,
): { provider: string; model: string } | null {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
  };
}
