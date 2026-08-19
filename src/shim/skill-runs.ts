import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { log } from "../log.js";

/**
 * Skill run records: what a browser-driven skill actually did, per invocation.
 *
 * The shim cannot see this any other way. openclaw runs the agentic loop
 * internally and its OpenAI-compat endpoint emits only `delta.content` text —
 * no tool calls, no tool results — so from out here a run that died on step 3
 * of 20 is indistinguishable from one that never started. Per-turn token usage
 * (see usage-telemetry.ts) says what a turn cost but not what it was doing.
 *
 * So the skills report for themselves: each action writes one JSON record to a
 * spool directory on the way out, and the shim ships them. A spool rather than
 * an openclaw hook, deliberately — a `before_tool_call` plugin sees call params
 * but not results, and nothing in the hook surface is guaranteed to carry a
 * subprocess's exit state. Files on a shared filesystem depend on none of that.
 *
 * The skill knows what it ran and how it went; it does NOT know which
 * conversation or task it belonged to. That is stitched on here, at drain time,
 * which is why draining happens in the turn's `finally` alongside the usage
 * rollup rather than on a timer.
 */

/** The on-disk record, as written by the skills' `_runrecord.py`. */
export interface SpooledSkillRun {
  schema?: string;
  run_id?: string;
  skill?: string;
  skill_version?: string;
  action?: string;
  status?: string;
  attempts?: number;
  session_reused?: boolean;
  self_repaired?: boolean;
  duration_ms?: number;
  step_count?: number;
  trace_truncated?: boolean;
  failed_step?: string | null;
  error_type?: string | null;
  error_message?: string | null;
  trace?: unknown[];
  started_at?: string;
  finished_at?: string;
}

/** Turn context the skill process has no way to know. */
export interface SkillRunContext {
  orgId: string;
  agentUid: string;
  conversationId?: string | null;
  taskId?: string | null;
}

/** One row ready for `public.skill_runs`. */
export interface SkillRunRow {
  run_id: string;
  org_id: string;
  agent_uid: string;
  conversation_id: string | null;
  task_id: string | null;
  skill_slug: string;
  skill_version: string | null;
  action: string;
  status: string;
  attempts: number;
  session_reused: boolean;
  self_repaired: boolean;
  duration_ms: number | null;
  step_count: number | null;
  failed_step: string | null;
  error_type: string | null;
  error_message: string | null;
  trace: unknown[];
  started_at: string | null;
  finished_at: string | null;
}

export const SKILL_RUN_SPOOL_LEAF = ".knox/skill-runs";

/** The statuses the table's check constraint accepts. */
const VALID_STATUSES = new Set(["success", "failure", "needs_confirmation"]);

/** Statuses a `failed_step` is meaningful — and permitted — on. */
const FAILED_STEP_STATUSES = new Set(["failure", "unknown"]);

/**
 * Caps. A spool is telemetry on the same volume the agent works on, so it must
 * be bounded even when the far end is broken: a database outage must cost the
 * oldest records, never the disk.
 */
const MAX_FILES_PER_DRAIN = 200;
const MAX_SPOOL_FILES = 1_000;
const MAX_TRACE_ENTRIES = 400;
const MAX_ERROR_CHARS = 2_000;

function clampString(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function clampInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * Shape one spooled record into a row, or null if it is not one.
 *
 * Deliberately strict about identity (a record with no run id, skill, or action
 * is not attributable and is dropped) and forgiving about everything else — a
 * skill running an older `_runrecord.py` should still be counted, just with
 * fewer columns filled in.
 */
export function toSkillRunRow(
  raw: SpooledSkillRun,
  ctx: SkillRunContext,
): SkillRunRow | null {
  const runId = typeof raw.run_id === "string" ? raw.run_id : "";
  const skill = typeof raw.skill === "string" ? raw.skill : "";
  const action = typeof raw.action === "string" ? raw.action : "";
  if (!runId || !skill || !action) return null;

  const status = typeof raw.status === "string" ? raw.status : "";
  const trace = Array.isArray(raw.trace) ? raw.trace.slice(0, MAX_TRACE_ENTRIES) : [];
  // An unrecognised status becomes `unknown` — a newer skill inventing one must
  // not have its runs silently dropped.
  const normalizedStatus = VALID_STATUSES.has(status) ? status : "unknown";

  return {
    run_id: runId,
    org_id: ctx.orgId,
    agent_uid: ctx.agentUid,
    conversation_id: ctx.conversationId ?? null,
    task_id: ctx.taskId ?? null,
    skill_slug: skill,
    skill_version: clampString(raw.skill_version, 64),
    action,
    status: normalizedStatus,
    attempts: clampInt(raw.attempts, 1, 1_000) ?? 1,
    session_reused: raw.session_reused === true,
    self_repaired: raw.self_repaired === true,
    duration_ms: clampInt(raw.duration_ms, 0, 86_400_000),
    step_count: clampInt(raw.step_count, 0, 100_000),
    // Only a failure names a failed step. A skill still on an older
    // `_runrecord.py` reports the step a `needs_confirmation` run paused at,
    // which the table rejects — and rightly so: a healthy pause must not land
    // in the tally of where a skill breaks. Dropped here rather than allowed to
    // fail the whole batch's insert.
    failed_step: FAILED_STEP_STATUSES.has(normalizedStatus)
      ? clampString(raw.failed_step, 200)
      : null,
    error_type: clampString(raw.error_type, 64),
    error_message: clampString(raw.error_message, MAX_ERROR_CHARS),
    trace,
    started_at: isIsoTimestamp(raw.started_at) ? raw.started_at : null,
    finished_at: isIsoTimestamp(raw.finished_at) ? raw.finished_at : null,
  };
}

/**
 * Reads and clears the skill-run spool.
 *
 * Every method swallows its own errors. A missing directory is the normal case
 * (no browser skill has run yet); an unreadable one is a problem for the logs,
 * never for the turn that happened to be finishing when it was noticed.
 */
export class SkillRunSpool {
  constructor(private readonly dir: string) {}

  /**
   * Read up to `MAX_FILES_PER_DRAIN` records and return them as rows.
   *
   * Files are NOT deleted here — `commit` does that, after the rows are safely
   * stored. A record that cannot be persisted is worth retrying on the next
   * turn; one that cannot be parsed is not, and is dropped immediately.
   */
  async drain(ctx: SkillRunContext): Promise<{ rows: SkillRunRow[]; files: string[] }> {
    const names = await this.list();
    if (names.length === 0) return { rows: [], files: [] };

    const rows: SkillRunRow[] = [];
    const files: string[] = [];
    for (const name of names.slice(0, MAX_FILES_PER_DRAIN)) {
      const path = join(this.dir, name);
      let parsed: SpooledSkillRun | null = null;
      try {
        parsed = JSON.parse(await readFile(path, "utf8")) as SpooledSkillRun;
      } catch (err) {
        // Unparseable: a truncated write, or something else entirely. It will
        // never become valid, so drop it rather than retrying it forever.
        log.debug("skill run record unreadable, dropping", {
          file: name,
          err: (err as Error).message,
        });
        await this.remove(path);
        continue;
      }
      const row = parsed ? toSkillRunRow(parsed, ctx) : null;
      if (!row) {
        await this.remove(path);
        continue;
      }
      rows.push(row);
      files.push(path);
    }
    return { rows, files };
  }

  /** Delete the files whose rows were stored. */
  async commit(files: string[]): Promise<void> {
    await Promise.all(files.map((path) => this.remove(path)));
  }

  /**
   * Drop the oldest records once the spool exceeds `MAX_SPOOL_FILES`.
   *
   * Only reached when records are piling up faster than they can be stored —
   * i.e. the database has been unreachable for a while. Losing the oldest
   * telemetry is the correct trade against filling the agent's volume.
   */
  async trim(): Promise<void> {
    try {
      const names = await this.list();
      if (names.length <= MAX_SPOOL_FILES) return;
      const withTimes = await Promise.all(
        names.map(async (name) => {
          const path = join(this.dir, name);
          try {
            return { path, mtime: (await stat(path)).mtimeMs };
          } catch {
            return { path, mtime: 0 };
          }
        }),
      );
      withTimes.sort((a, b) => a.mtime - b.mtime);
      const excess = withTimes.slice(0, withTimes.length - MAX_SPOOL_FILES);
      log.warn("skill run spool over cap, dropping oldest", {
        held: withTimes.length,
        dropped: excess.length,
      });
      await Promise.all(excess.map((entry) => this.remove(entry.path)));
    } catch {
      /* trimming is best effort */
    }
  }

  private async list(): Promise<string[]> {
    try {
      const names = await readdir(this.dir);
      // `.tmp` files are writes still in flight — `_runrecord.py` renames into
      // place, so only the final `.json` name is ever complete.
      return names.filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
  }

  private async remove(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      /* already gone */
    }
  }
}
