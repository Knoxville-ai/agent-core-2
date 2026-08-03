import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTokenUsage, historyToOpenaiMessages } from "./routes-messages.js";
import type { AgentEnv } from "../env.js";
import type { ModelCapabilities } from "./model-capabilities.js";
import type { AttachmentRow, MessageRow, MessagingDB } from "./supabase-db.js";

/** Minimal MessagingDB stub: only downloadAttachmentBase64 is exercised. */
function fakeDb(bytesByPath: Record<string, Buffer>): {
  db: MessagingDB;
  downloads: string[];
} {
  const downloads: string[] = [];
  const db = {
    async downloadAttachmentBase64(path: string): Promise<string | null> {
      downloads.push(path);
      const buf = bytesByPath[path];
      return buf ? buf.toString("base64") : null;
    },
  } as unknown as MessagingDB;
  return { db, downloads };
}

function userRow(id: string, content: string): MessageRow {
  return {
    id,
    role: "user",
    content,
    system_generated: false,
    sender_kind: "user",
    sender_id: "u1",
    created_at: "2026-07-01T00:00:00Z",
  } as unknown as MessageRow;
}

function imageAtt(over: Partial<AttachmentRow>): AttachmentRow {
  return {
    id: "att-1",
    message_id: "m1",
    storage_path: "orgs/o/conversations/c/pic.png",
    mime_type: "image/png",
    size_bytes: 4,
    width: null,
    height: null,
    original_name: "BC ATHLETICS.png",
    ...over,
  } as AttachmentRow;
}

const MULTIMODAL: ModelCapabilities = { multimodal: true, fileInput: false };
const TEXT_ONLY: ModelCapabilities = { multimodal: false, fileInput: false };

describe("historyToOpenaiMessages image materialization", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "knox-ws-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it("writes images to the workspace and tells the model the path", async () => {
    const bytes = Buffer.from("\x89PNG", "binary");
    const att = imageAtt({ size_bytes: bytes.length });
    const { db } = fakeDb({ [att.storage_path]: bytes });
    const attByMsg = new Map([["m1", [att]]]);

    const out = await historyToOpenaiMessages(
      [userRow("m1", "make a mockup")],
      attByMsg,
      MULTIMODAL,
      db,
      ws,
      "conv-123",
    );

    // File landed on disk under the per-conversation dir, id-prefixed.
    const expectedPath = join(
      ws,
      "attachments",
      "conv-123",
      "att-1__BC_ATHLETICS.png",
    );
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath)).toEqual(bytes);

    // Content is a multimodal array with a text part naming the disk path
    // plus the inlined image.
    const content = out[0]!.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    const noteText = content
      .filter((p) => p.type === "text")
      .map((p) => p.text as string)
      .join("\n");
    expect(noteText).toContain(expectedPath);
    expect(content.some((p) => p.type === "image_url")).toBe(true);
  });

  it("materializes to disk even for text-only models (no inlined image)", async () => {
    const bytes = Buffer.from("gif89a", "binary");
    const att = imageAtt({
      id: "att-2",
      storage_path: "orgs/o/conversations/c/logo.gif",
      mime_type: "image/gif",
      original_name: "logo.gif",
      size_bytes: bytes.length,
    });
    const { db } = fakeDb({ [att.storage_path]: bytes });

    const out = await historyToOpenaiMessages(
      [userRow("m1", "composite this")],
      new Map([["m1", [att]]]),
      TEXT_ONLY,
      db,
      ws,
      "conv-9",
    );

    const p = join(ws, "attachments", "conv-9", "att-2__logo.gif");
    expect(existsSync(p)).toBe(true);
    // Plain-string content (no inlined image on a text-only model), but the
    // path note is folded in so a deterministic skill can still use it.
    const content = out[0]!.content as string;
    expect(typeof content).toBe("string");
    expect(content).toContain("composite this");
    expect(content).toContain(p);
  });

  it("is idempotent: a re-materialized image is not downloaded again", async () => {
    const bytes = Buffer.from("PNGDATA", "binary");
    const att = imageAtt({ size_bytes: bytes.length });
    const { db, downloads } = fakeDb({ [att.storage_path]: bytes });
    const rows = [userRow("m1", "hi")];
    const attByMsg = new Map([["m1", [att]]]);

    await historyToOpenaiMessages(rows, attByMsg, TEXT_ONLY, db, ws, "c1");
    expect(downloads.length).toBe(1);
    // Second pass (e.g. next turn replaying history): file already on disk
    // with the right size, so no re-download.
    await historyToOpenaiMessages(rows, attByMsg, TEXT_ONLY, db, ws, "c1");
    expect(downloads.length).toBe(1);
  });
});

describe("buildTokenUsage prompt-cache decomposition", () => {
  const env = { LLM_PROVIDER: "openrouter", LLM_MODEL: "qwen3.7-plus" } as AgentEnv;
  const usage = { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 };

  it("keeps the legacy shape when no cache rollup is available", () => {
    // The telemetry plugin may not be loaded (older image, plugin disabled).
    // token_usage must then look exactly as it always has.
    const built = buildTokenUsage(usage, env);
    expect(built).toEqual({
      input_tokens: 1000,
      output_tokens: 50,
      total_tokens: 1050,
      provider: "openrouter",
      model: "qwen3.7-plus",
    });
  });

  it("decomposes input_tokens into uncached + cache_read", () => {
    const built = buildTokenUsage(usage, env, {
      modelCalls: 4,
      uncachedInput: 100,
      cacheRead: 900,
      cacheWrite: 120,
    });
    // input_tokens stays INCLUSIVE of cache reads (that is what the compat
    // endpoint reports); the new fields split it without redefining it.
    expect(built?.input_tokens).toBe(1000);
    expect(built?.uncached_input_tokens).toBe(100);
    expect(built?.cache_read_input_tokens).toBe(900);
    expect(built?.cache_creation_input_tokens).toBe(120);
    expect(built?.model_calls).toBe(4);
  });

  it("preserves the identity uncached + cache_read === input_tokens", () => {
    for (const cacheRead of [0, 1, 499, 1000]) {
      const built = buildTokenUsage(usage, env, {
        modelCalls: 1,
        uncachedInput: 12345, // deliberately inconsistent with the frame
        cacheRead,
        cacheWrite: 0,
      });
      expect(
        (built?.uncached_input_tokens as number) + (built?.cache_read_input_tokens as number),
      ).toBe(built?.input_tokens);
    }
  });

  it("clamps a cache read that overshoots the reported prompt total", () => {
    // Retries inside the agentic loop can make the plugin's summed cacheRead
    // drift above the final frame's prompt_tokens. Clamp rather than emit a
    // negative uncached count.
    const built = buildTokenUsage(usage, env, {
      modelCalls: 9,
      uncachedInput: 0,
      cacheRead: 5000,
      cacheWrite: 0,
    });
    expect(built?.cache_read_input_tokens).toBe(1000);
    expect(built?.uncached_input_tokens).toBe(0);
  });

  it("records the resolved provider/model ref when the plugin reported one", () => {
    const built = buildTokenUsage(usage, env, {
      modelCalls: 1,
      uncachedInput: 1000,
      cacheRead: 0,
      cacheWrite: 0,
      resolvedRef: "openrouter/qwen/qwen3.7-plus",
    });
    expect(built?.resolved_ref).toBe("openrouter/qwen/qwen3.7-plus");
  });

  it("still returns undefined when the gateway reported no usage at all", () => {
    expect(buildTokenUsage(null, env, { modelCalls: 3, uncachedInput: 1, cacheRead: 1, cacheWrite: 0 })).toBeUndefined();
  });
});
