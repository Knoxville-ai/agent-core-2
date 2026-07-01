import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { historyToOpenaiMessages } from "./routes-messages.js";
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
