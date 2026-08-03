import { describe, expect, it } from "vitest";

import { MessagingDB } from "./supabase-db.js";
import type { AgentEnv } from "../env.js";
import type { MessageRow } from "./supabase-db.js";

/**
 * Minimal fake of the PostgREST query builder for the ONE shape listMessages
 * uses: from().select().eq().order().order().limit() → { data, error }.
 *
 * It applies the recorded orders + limit to a seeded row set so the test
 * verifies the ACTUAL windowing (newest N, chronological), not just that some
 * order() calls were made.
 */
function fakeClient(rows: MessageRow[]) {
  const calls: { orders: Array<{ col: string; ascending: boolean }>; limit?: number } = {
    orders: [],
  };
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    order: (col: string, opts: { ascending: boolean }) => {
      calls.orders.push({ col, ascending: opts.ascending });
      return builder;
    },
    limit: (n: number) => {
      calls.limit = n;
      // Apply the recorded sort (col by col, in call order) then the limit,
      // mirroring PostgREST semantics closely enough to exercise the fix.
      const sorted = [...rows].sort((a, b) => {
        for (const { col, ascending } of calls.orders) {
          const av = String((a as unknown as Record<string, unknown>)[col]);
          const bv = String((b as unknown as Record<string, unknown>)[col]);
          if (av !== bv) return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
        }
        return 0;
      });
      return Promise.resolve({ data: sorted.slice(0, n), error: null });
    },
  };
  const client = { from: () => builder } as unknown;
  return { client, calls };
}

const env = { SUPABASE_URL: "http://x", SUPABASE_SERVICE_ROLE_KEY: "k" } as AgentEnv;

function msg(id: string, createdAt: string): MessageRow {
  return {
    id,
    role: "user",
    content: id,
    status: "complete",
    system_generated: false,
    sender_kind: "user",
    sender_id: "u",
    created_at: createdAt,
  };
}

describe("MessagingDB.listMessages windowing", () => {
  it("returns the NEWEST `limit` rows, in chronological order", async () => {
    // 6 messages, ask for 3. The bug returned the oldest 3 (m1,m2,m3); the fix
    // returns the newest 3 in chronological order (m4,m5,m6).
    const rows = [
      msg("m1", "2026-01-01T00:00:01Z"),
      msg("m2", "2026-01-01T00:00:02Z"),
      msg("m3", "2026-01-01T00:00:03Z"),
      msg("m4", "2026-01-01T00:00:04Z"),
      msg("m5", "2026-01-01T00:00:05Z"),
      msg("m6", "2026-01-01T00:00:06Z"),
    ];
    const { client } = fakeClient(rows);
    const db = new MessagingDB(env, client as never);
    const out = await db.listMessages("conv", 3);
    expect(out.map((r) => r.id)).toEqual(["m4", "m5", "m6"]);
  });

  it("includes the just-inserted newest row even past the limit", async () => {
    // The regression: the current turn (newest) must always be in the window.
    const rows = Array.from({ length: 10 }, (_, i) =>
      msg(`m${i}`, `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`),
    );
    const current = msg("CURRENT", "2026-01-01T00:00:99Z");
    const { client } = fakeClient([...rows, current]);
    const db = new MessagingDB(env, client as never);
    const out = await db.listMessages("conv", 5);
    expect(out.at(-1)?.id).toBe("CURRENT");
    expect(out).toHaveLength(5);
  });

  it("breaks created_at ties deterministically on id", async () => {
    // All same created_at → the id secondary order decides the window + order.
    const rows = [
      msg("a", "2026-01-01T00:00:00Z"),
      msg("b", "2026-01-01T00:00:00Z"),
      msg("c", "2026-01-01T00:00:00Z"),
    ];
    const { client, calls } = fakeClient(rows);
    const db = new MessagingDB(env, client as never);
    const out = await db.listMessages("conv", 2);
    // Newest-2 by (created_at desc, id desc) = {c, b}; reversed to chronological.
    expect(out.map((r) => r.id)).toEqual(["b", "c"]);
    // And the query actually asked for both orders, descending.
    expect(calls.orders).toEqual([
      { col: "created_at", ascending: false },
      { col: "id", ascending: false },
    ]);
  });

  it("returns [] on a query error rather than throwing", async () => {
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: null, error: { message: "boom" } }),
              }),
            }),
          }),
        }),
      }),
    } as unknown;
    const db = new MessagingDB(env, client as never);
    expect(await db.listMessages("conv")).toEqual([]);
  });
});
