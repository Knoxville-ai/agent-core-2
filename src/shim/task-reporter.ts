import { log } from "../log.js";

/**
 * The executor's channel back to the platform (console migration 0047).
 *
 * A long-running task has no open connection to whoever asked for it — that is
 * the entire point. So everything the caller eventually sees flows through this
 * client: progress notes, proof-of-life heartbeats, and the terminal result.
 *
 * Auth is the per-task callback token the platform issued in the start payload.
 * It grants exactly one capability (report on this task), which is why it is
 * safe to hold for the hour a task might run, and why an externally-hosted
 * (BYOA) agent can use the identical surface.
 *
 * Every method is FAIL-SOFT on transport errors: a dropped progress report must
 * never take down the work it was describing. The terminal report is the one
 * that matters, so it retries with backoff — and even if it never lands, the
 * platform's reaper notices the missing heartbeats and fails the task rather
 * than leaving it running forever.
 */

export interface TaskReporterOptions {
  taskId: string;
  callbackUrl: string;
  callbackToken: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export type TerminalStatus = "complete" | "failed" | "cancelled";

/** What the platform tells us back on every report. */
export interface ReportAck {
  ok: boolean;
  /** True once someone has asked this task to stop. */
  cancelRequested: boolean;
  /** Set when the platform considers the task already finished. */
  terminal: boolean;
}

const REQUEST_TIMEOUT_MS = 10_000;
const TERMINAL_RETRIES = 4;

export class TaskReporter {
  private readonly taskId: string;
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(opts: TaskReporterOptions) {
    this.taskId = opts.taskId;
    this.url = opts.callbackUrl.replace(/\/+$/, "");
    this.token = opts.callbackToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl =
      opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Origin of the callback URL, for diagnostics. Never the path (task id) or
   *  the body (token). */
  private origin(): string {
    try {
      return new URL(this.url).origin;
    } catch {
      return "(unparseable)";
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  private async send(
    path: string,
    method: "POST" | "PATCH",
    body: unknown,
  ): Promise<ReportAck> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${this.url}${path}`, {
        method,
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
        // A redirect is a FAILURE, not something to chase. Following one is how
        // an auth gateway silently swallows a report: 302 -> login page -> 200
        // HTML, which every naive success check reads as "recorded".
        redirect: "manual",
      });

      const contentType = res.headers.get("content-type") ?? "";

      if (!res.ok || res.type === "opaqueredirect" || res.status >= 300) {
        const text = await res.text().catch(() => "");
        log.warn("task report rejected", {
          task_id: this.taskId,
          status: res.status,
          content_type: contentType,
          location: res.headers.get("location") ?? undefined,
          body: text.slice(0, 300),
        });
        return { ok: false, cancelRequested: false, terminal: false };
      }

      // A 2xx is NOT proof the platform recorded anything. An auth gateway or a
      // deployment-protection interstitial in front of the console answers 200
      // with an HTML page, and the original version of this method returned
      // ok:true for it — so every heartbeat, progress note, and terminal result
      // "succeeded" while the task row sat untouched at status='running' with
      // nothing in the log to show for it. Verify the response is actually ours:
      // JSON, and carrying the `ok` flag every task-callback route returns.
      if (!contentType.includes("application/json")) {
        const text = await res.text().catch(() => "");
        log.warn("task report got a non-JSON response (not the task API)", {
          task_id: this.taskId,
          status: res.status,
          content_type: contentType,
          url_origin: this.origin(),
          body: text.slice(0, 300),
        });
        return { ok: false, cancelRequested: false, terminal: false };
      }

      const parsed = (await res.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      if (!parsed || parsed.ok !== true) {
        log.warn("task report response did not confirm the write", {
          task_id: this.taskId,
          status: res.status,
          body: JSON.stringify(parsed ?? null).slice(0, 300),
        });
        return { ok: false, cancelRequested: false, terminal: false };
      }

      return {
        ok: true,
        cancelRequested: parsed.cancel_requested === true,
        terminal:
          typeof parsed.status === "string" && parsed.status !== "running",
      };
    } catch (err) {
      log.warn("task report failed", {
        task_id: this.taskId,
        err: String(err),
      });
      return { ok: false, cancelRequested: false, terminal: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Proof of life, with nothing to say. The ack carries `cancelRequested`,
   * which is how a cooperative cancel reaches a task mid-run: the platform
   * flips a flag, and the executor learns about it on its next beat.
   */
  async heartbeat(): Promise<ReportAck> {
    return this.send("", "PATCH", {});
  }

  /** A progress note for the caller's task card, and proof of life. */
  async progress(note: string, pct?: number | null): Promise<ReportAck> {
    return this.send("", "PATCH", {
      progress: note,
      ...(typeof pct === "number" ? { pct } : {}),
    });
  }

  /** An append-only timeline entry that does NOT overwrite the headline note. */
  async event(
    kind: "progress" | "status" | "tool" | "error",
    note: string,
    data?: unknown,
  ): Promise<ReportAck> {
    return this.send("/events", "POST", { kind, note, data: data ?? null });
  }

  /**
   * The terminal report. Retried with backoff because this is the message the
   * whole task exists to deliver — losing it means the caller's session is
   * never woken (until the reaper notices, which is slower and less useful).
   */
  async finish(input: {
    status: TerminalStatus;
    summary?: string | null;
    error?: string | null;
    result?: unknown;
  }): Promise<boolean> {
    const body = {
      status: input.status,
      summary: input.summary ?? null,
      error: input.error ?? null,
      result: input.result ?? null,
    };
    for (let attempt = 0; attempt < TERMINAL_RETRIES; attempt++) {
      const ack = await this.send("", "PATCH", body);
      if (ack.ok) return true;
      if (attempt < TERMINAL_RETRIES - 1) {
        await this.sleepImpl(1000 * 2 ** attempt);
      }
    }
    log.error("task terminal report never landed", {
      task_id: this.taskId,
      status: input.status,
    });
    return false;
  }
}
