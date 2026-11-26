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

describe("MessagingDB.setConversationTitleIfUnset", () => {
  /** Records the update chain; answers with `rows` (the rows the UPDATE matched). */
  function titleClient(result: { data: unknown; error: { message: string } | null }) {
    const calls: Array<[string, ...unknown[]]> = [];
    const builder: Record<string, unknown> = {
      update: (patch: unknown) => {
        calls.push(["update", patch]);
        return builder;
      },
      eq: (col: string, value: unknown) => {
        calls.push(["eq", col, value]);
        return builder;
      },
      is: (col: string, value: unknown) => {
        calls.push(["is", col, value]);
        return builder;
      },
      select: (cols: string) => {
        calls.push(["select", cols]);
        return Promise.resolve(result);
      },
    };
    const client = {
      from: (table: string) => {
        calls.push(["from", table]);
        return builder;
      },
    } as unknown;
    return { client, calls };
  }

  it("writes the title only where it is still null, in the UPDATE itself", async () => {
    const { client, calls } = titleClient({ data: [{ id: "c1" }], error: null });
    const db = new MessagingDB(env, client as never);
    expect(await db.setConversationTitleIfUnset("c1", "Reconcile June invoices")).toBe(true);
    expect(calls).toEqual([
      ["from", "conversations"],
      ["update", { title: "Reconcile June invoices" }],
      ["eq", "id", "c1"],
      ["is", "title", null],
      ["select", "id"],
    ]);
  });

  it("reports false when the conversation already had a title (nothing matched)", async () => {
    const { client } = titleClient({ data: [], error: null });
    const db = new MessagingDB(env, client as never);
    expect(await db.setConversationTitleIfUnset("c1", "X")).toBe(false);
  });

  it("reports false on a query error rather than throwing", async () => {
    const { client } = titleClient({ data: null, error: { message: "boom" } });
    const db = new MessagingDB(env, client as never);
    expect(await db.setConversationTitleIfUnset("c1", "X")).toBe(false);
  });
});

describe("MessagingDB.getRecentMemories (status + provenance)", () => {
  type Call = { method: string; args: unknown[] };
  /** Records every builder call per query; `results` answers each query in turn. */
  function memoryClient(results: Array<{ data: unknown; error: { code?: string; message: string } | null }>) {
    const queries: Call[][] = [];
    const client = {
      from: (table: string) => {
        const calls: Call[] = [{ method: "from", args: [table] }];
        queries.push(calls);
        const builder: Record<string, unknown> = {};
        for (const m of ["select", "eq", "is", "or", "order"]) {
          builder[m] = (...args: unknown[]) => {
            calls.push({ method: m, args });
            return builder;
          };
        }
        builder.limit = (...args: unknown[]) => {
          calls.push({ method: "limit", args });
          return Promise.resolve(results.shift() ?? { data: [], error: null });
        };
        return builder;
      },
    };
    return { client, queries };
  }

  it("selects only active, non-superseded memories of trusted or confirmed origin", async () => {
    const rows = [{ title: "t", body: "b", kind: "fact", tags: [] }];
    const { client, queries } = memoryClient([{ data: rows, error: null }]);
    const out = await new MessagingDB(env, client as never).getRecentMemories("agent-1");
    expect(out).toEqual(rows);
    expect(queries).toHaveLength(1);
    const calls = queries[0]!;
    expect(calls).toContainEqual({ method: "eq", args: ["agent_uid", "agent-1"] });
    expect(calls).toContainEqual({ method: "eq", args: ["status", "active"] });
    expect(calls).toContainEqual({ method: "is", args: ["superseded_by", null] });
    const or = calls.find((c) => c.method === "or");
    expect(or?.args[0]).toBe("origin_trust.is.null,origin_trust.eq.trusted,decided_at.not.is.null");
    // Untrusted / unknown origins are not admitted by any branch of the filter.
    expect(String(or?.args[0])).not.toMatch(/untrusted|unknown/);
  });

  it("retries without the provenance filter on a database that predates the column", async () => {
    const rows = [{ title: null, body: "b", kind: null, tags: null }];
    const { client, queries } = memoryClient([
      { data: null, error: { code: "42703", message: "column agent_memories.origin_trust does not exist" } },
      { data: rows, error: null },
    ]);
    const out = await new MessagingDB(env, client as never).getRecentMemories("agent-1");
    expect(out).toEqual(rows);
    expect(queries).toHaveLength(2);
    expect(queries[1]!.some((c) => c.method === "or")).toBe(false);
    expect(queries[1]).toContainEqual({ method: "eq", args: ["status", "active"] });
  });

  it("returns nothing (no unfiltered retry) on any other error", async () => {
    const { client, queries } = memoryClient([{ data: null, error: { code: "57014", message: "statement timeout" } }]);
    expect(await new MessagingDB(env, client as never).getRecentMemories("agent-1")).toEqual([]);
    expect(queries).toHaveLength(1);
  });
});
