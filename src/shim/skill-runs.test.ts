import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  SkillRunSpool,
  toSkillRunRow,
  type SkillRunContext,
  type SpooledSkillRun,
} from "./skill-runs.js";

const ctx: SkillRunContext = {
  orgId: "org_1",
  agentUid: "0123456789abcdef",
  conversationId: "conv_1",
};

const record = (over: Partial<SpooledSkillRun> = {}): SpooledSkillRun => ({
  schema: "knox.skill_run/1",
  run_id: "11111111-1111-1111-1111-111111111111",
  skill: "drivethru-adidas-click",
  skill_version: "0.8.0",
  action: "create-purchase-order",
  status: "success",
  attempts: 1,
  session_reused: false,
  self_repaired: false,
  duration_ms: 12_345,
  step_count: 2,
  failed_step: null,
  error_type: null,
  error_message: null,
  trace: [
    { step: "logged-in", ms: 900 },
    { step: "cart-created", ms: 1_400 },
  ],
  started_at: "2026-08-19T00:00:00.000Z",
  finished_at: "2026-08-19T00:00:12.345Z",
  ...over,
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "knox-skillruns-"));
});

async function spool(name: string, body: unknown): Promise<void> {
  await writeFile(
    join(dir, name),
    typeof body === "string" ? body : JSON.stringify(body),
    "utf8",
  );
}

describe("toSkillRunRow", () => {
  it("stitches turn context onto the skill's own record", () => {
    const row = toSkillRunRow(record(), ctx);
    // The skill knows what it ran; only the shim knows where it ran.
    expect(row).toMatchObject({
      run_id: "11111111-1111-1111-1111-111111111111",
      org_id: "org_1",
      agent_uid: "0123456789abcdef",
      conversation_id: "conv_1",
      task_id: null,
      skill_slug: "drivethru-adidas-click",
      action: "create-purchase-order",
      status: "success",
    });
  });

  it("keeps the failed step, which is the point of the record", () => {
    const row = toSkillRunRow(
      record({ status: "failure", failed_step: "logged-in", error_type: "config_error" }),
      ctx,
    );
    expect(row?.failed_step).toBe("logged-in");
    expect(row?.error_type).toBe("config_error");
  });

  it("drops a record with no identity", () => {
    expect(toSkillRunRow(record({ run_id: undefined }), ctx)).toBeNull();
    expect(toSkillRunRow(record({ skill: undefined }), ctx)).toBeNull();
    expect(toSkillRunRow(record({ action: undefined }), ctx)).toBeNull();
  });

  it("maps an unrecognised status to unknown rather than dropping the run", () => {
    // A newer skill inventing a status must still be counted.
    expect(toSkillRunRow(record({ status: "partial" }), ctx)?.status).toBe("unknown");
  });

  it("drops a failed step from a run that did not fail", () => {
    // A skill on an older `_runrecord.py` reports the step a paused run
    // reached. The table rejects that (a healthy pause is not a break), so it
    // is dropped here rather than left to fail the whole batch's insert.
    const paused = toSkillRunRow(
      record({ status: "needs_confirmation", failed_step: "lines-added" }),
      ctx,
    );
    expect(paused?.failed_step).toBeNull();

    const succeeded = toSkillRunRow(
      record({ status: "success", failed_step: "logged-in" }),
      ctx,
    );
    expect(succeeded?.failed_step).toBeNull();

    // ...but a genuinely unknown status may well be a failure, so it keeps one.
    const unknown = toSkillRunRow(
      record({ status: "weird", failed_step: "logged-in" }),
      ctx,
    );
    expect(unknown?.failed_step).toBe("logged-in");
  });

  it("accepts needs_confirmation as its own outcome", () => {
    // A paused order is neither a success nor a failure; conflating it with
    // either would misreport the skill's success rate.
    expect(toSkillRunRow(record({ status: "needs_confirmation" }), ctx)?.status).toBe(
      "needs_confirmation",
    );
  });

  it("fills in defaults for an older record shape", () => {
    const row = toSkillRunRow(
      { run_id: "r", skill: "s", action: "a" } as SpooledSkillRun,
      ctx,
    );
    expect(row).toMatchObject({
      status: "unknown",
      attempts: 1,
      session_reused: false,
      duration_ms: null,
      trace: [],
    });
  });

  it("clamps oversized fields", () => {
    const row = toSkillRunRow(
      record({
        error_message: "x".repeat(5_000),
        trace: Array.from({ length: 900 }, (_, i) => ({ step: `s${i}`, ms: i })),
        attempts: 10 ** 9,
      }),
      ctx,
    );
    expect(row!.error_message!.length).toBeLessThanOrEqual(2_001);
    expect(row!.trace.length).toBe(400);
    expect(row!.attempts).toBe(1_000);
  });

  it("rejects a non-timestamp rather than storing it", () => {
    expect(toSkillRunRow(record({ started_at: "whenever" }), ctx)?.started_at).toBeNull();
  });
});

describe("SkillRunSpool", () => {
  it("returns nothing when the directory does not exist", async () => {
    const missing = new SkillRunSpool(join(dir, "nope"));
    await expect(missing.drain(ctx)).resolves.toEqual({ rows: [], files: [] });
  });

  it("reads spooled records", async () => {
    await spool("a.json", record({ run_id: "a" }));
    await spool("b.json", record({ run_id: "b", skill: "sportsinc-sportslink" }));

    const { rows, files } = await new SkillRunSpool(dir).drain(ctx);
    expect(rows.map((row) => row.run_id).sort()).toEqual(["a", "b"]);
    expect(files).toHaveLength(2);
  });

  it("ignores in-flight temp files", async () => {
    // `_runrecord.py` writes to `.<id>.tmp` and renames, so only `.json` is
    // ever a complete record.
    await spool(".half-written.tmp", '{"run_id": "partial"');
    await spool("done.json", record({ run_id: "done" }));

    const { rows } = await new SkillRunSpool(dir).drain(ctx);
    expect(rows.map((row) => row.run_id)).toEqual(["done"]);
  });

  it("drops unparseable records instead of retrying them forever", async () => {
    await spool("broken.json", "{not json");
    const spoolDir = new SkillRunSpool(dir);

    const { rows } = await spoolDir.drain(ctx);
    expect(rows).toEqual([]);
    // Already removed — a truncated file will never become valid.
    expect(await readdir(dir)).toEqual([]);
  });

  it("does not delete records until they are committed", async () => {
    await spool("a.json", record({ run_id: "a" }));
    const spoolDir = new SkillRunSpool(dir);

    const { files } = await spoolDir.drain(ctx);
    // Still on disk: a database blip must cost a retry, not the record.
    expect(await readdir(dir)).toEqual(["a.json"]);

    await spoolDir.commit(files);
    expect(await readdir(dir)).toEqual([]);
  });

  it("survives a commit of files that are already gone", async () => {
    const spoolDir = new SkillRunSpool(dir);
    await expect(spoolDir.commit([join(dir, "ghost.json")])).resolves.toBeUndefined();
  });

  it("caps how much it reads in one drain", async () => {
    await Promise.all(
      Array.from({ length: 250 }, (_, i) =>
        spool(`r${i}.json`, record({ run_id: `r${i}` })),
      ),
    );
    const { rows } = await new SkillRunSpool(dir).drain(ctx);
    expect(rows).toHaveLength(200);
  });

  it("trims the spool when it exceeds the cap", async () => {
    // Stands in for a long database outage: telemetry must lose its oldest
    // records rather than fill the volume the agent works on.
    await Promise.all(
      Array.from({ length: 1_050 }, (_, i) =>
        spool(`r${i}.json`, record({ run_id: `r${i}` })),
      ),
    );
    const spoolDir = new SkillRunSpool(dir);
    await spoolDir.trim();
    expect((await readdir(dir)).length).toBe(1_000);
  });

  it("leaves a spool under the cap alone", async () => {
    await spool("a.json", record({ run_id: "a" }));
    await new SkillRunSpool(dir).trim();
    expect(await readdir(dir)).toEqual(["a.json"]);
  });
});
