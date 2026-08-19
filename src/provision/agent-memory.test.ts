import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryCheckpoint, type StorageLike } from "./agent-memory.js";

/** In-memory StorageLike: key (relative to agent prefix) → contents. */
class FakeStorage implements StorageLike {
  files = new Map<string, string>();
  contentTypes = new Map<string, string>();
  uploads: string[] = [];
  removes: string[] = [];

  async downloadText(rel: string): Promise<string | null> {
    return this.files.get(rel) ?? null;
  }
  async uploadText(rel: string, body: string, contentType: string): Promise<void> {
    this.files.set(rel, body);
    this.contentTypes.set(rel, contentType);
    this.uploads.push(rel);
  }
  async list(rel: string): Promise<string[]> {
    const prefix = `${rel.replace(/\/+$/, "")}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        if (!rest.includes("/")) names.add(rest);
      }
    }
    return [...names];
  }
  async remove(rel: string): Promise<void> {
    this.files.delete(rel);
    this.removes.push(rel);
  }
}

const CONSOLE_KEYS = [
  "memory/system_prompt.md",
  "memory/identity.md",
  "memory/boot.md",
];

describe("MemoryCheckpoint", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "knox-mem-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function writeWs(rel: string, body: string): void {
    const abs = join(workspace, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }

  it("round-trips playbook + notes through Storage and restores them", async () => {
    const storage = new FakeStorage();
    writeWs("playbook.md", "PB");
    writeWs("notes/foo.md", "NOTE");

    const mc = new MemoryCheckpoint({ workspace, storage });
    await mc.checkpoint();

    expect(storage.files.get("memory/playbook.md")).toBe("PB");
    expect(storage.files.get("state/notes/foo.md")).toBe("NOTE");

    // Simulate a fresh container (re-provisioned service): empty workspace,
    // same Storage. restore() must pull both files back.
    const fresh = mkdtempSync(join(tmpdir(), "knox-mem-fresh-"));
    try {
      const mc2 = new MemoryCheckpoint({ workspace: fresh, storage });
      await mc2.restore();
      expect(readFileSync(join(fresh, "playbook.md"), "utf8")).toBe("PB");
      expect(readFileSync(join(fresh, "notes/foo.md"), "utf8")).toBe("NOTE");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("NEVER writes back console-authored prompts (guard)", async () => {
    const storage = new FakeStorage();
    // Console prompts present on disk AND modified — must still never upload.
    writeWs("SOUL.md", "system prompt edited locally");
    writeWs("AGENTS.md", "identity edited locally");
    writeWs("TOOLS.md", "boot edited locally");
    writeWs("playbook.md", "agent memory");

    const mc = new MemoryCheckpoint({ workspace, storage });
    await mc.checkpoint();

    for (const key of CONSOLE_KEYS) {
      expect(storage.files.has(key)).toBe(false);
    }
    // Only the agent-owned playbook was uploaded.
    expect(storage.uploads).toEqual(["memory/playbook.md"]);
  });

  it("volume wins on restore: a present local copy is not overwritten", async () => {
    const storage = new FakeStorage();
    storage.files.set("memory/playbook.md", "REMOTE");
    writeWs("playbook.md", "LOCAL");

    const mc = new MemoryCheckpoint({ workspace, storage });
    await mc.restore();
    expect(readFileSync(join(workspace, "playbook.md"), "utf8")).toBe("LOCAL");

    // A local copy that diverges from Storage is pushed up on next checkpoint.
    await mc.checkpoint();
    expect(storage.files.get("memory/playbook.md")).toBe("LOCAL");
  });

  it("restores from Storage when the volume is empty", async () => {
    const storage = new FakeStorage();
    storage.files.set("memory/playbook.md", "REMOTE");

    const mc = new MemoryCheckpoint({ workspace, storage });
    await mc.restore();
    expect(readFileSync(join(workspace, "playbook.md"), "utf8")).toBe("REMOTE");
  });

  it("avoids echo: an unchanged checkpoint after restore uploads nothing", async () => {
    const storage = new FakeStorage();
    storage.files.set("memory/playbook.md", "X");
    storage.files.set("state/notes/a.md", "A");

    const mc = new MemoryCheckpoint({ workspace, storage });
    await mc.restore();
    storage.uploads = [];

    await mc.checkpoint();
    expect(storage.uploads).toEqual([]);
  });

  it("mirrors a local deletion to Storage", async () => {
    const storage = new FakeStorage();
    writeWs("notes/gone.md", "bye");
    const mc = new MemoryCheckpoint({ workspace, storage });
    await mc.checkpoint();
    expect(storage.files.has("state/notes/gone.md")).toBe(true);

    rmSync(join(workspace, "notes/gone.md"));
    await mc.checkpoint();
    expect(storage.files.has("state/notes/gone.md")).toBe(false);
    expect(storage.removes).toContain("state/notes/gone.md");
  });

  it("uploads only genuinely changed files on a second checkpoint", async () => {
    const storage = new FakeStorage();
    writeWs("playbook.md", "v1");
    writeWs("notes/a.md", "a1");
    const mc = new MemoryCheckpoint({ workspace, storage });
    await mc.checkpoint();
    storage.uploads = [];

    // Edit only the note.
    writeWs("notes/a.md", "a2");
    await mc.checkpoint();
    expect(storage.uploads).toEqual(["state/notes/a.md"]);
    expect(storage.files.get("state/notes/a.md")).toBe("a2");
    expect(storage.files.get("memory/playbook.md")).toBe("v1");
  });

  it("round-trips a skill overlay, which is what makes a learned fix durable", async () => {
    // `workspace/skills/` is wiped and reinstalled from ClawHub on every boot,
    // so a fix written into a skill's own files lasts exactly until the next
    // restart. Overlays live in a SIBLING directory the wipe never touches.
    const storage = new FakeStorage();
    writeWs(
      "skill-overlays/drivethru-adidas-click.json",
      JSON.stringify({ selectors: { "carts.list": ".o-newCartsList" } }),
    );

    const mc = new MemoryCheckpoint({ workspace, storage });
    await mc.checkpoint();

    const key = "state/skill-overlays/drivethru-adidas-click.json";
    expect(storage.files.get(key)).toContain("o-newCartsList");
    // JSON, not markdown: uploadText hardcoded text/markdown before overlays.
    expect(storage.contentTypes.get(key)).toBe("application/json");

    // A fresh container with an empty volume gets the fix back.
    const fresh = mkdtempSync(join(tmpdir(), "knox-mem-overlay-"));
    try {
      await new MemoryCheckpoint({ workspace: fresh, storage }).restore();
      expect(
        readFileSync(join(fresh, "skill-overlays/drivethru-adidas-click.json"), "utf8"),
      ).toContain("o-newCartsList");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("mirrors an overlay deletion, so a reverted fix does not come back", async () => {
    // isAgentOwned gates the DELETE path specifically. Without the overlay
    // prefix there the key would be dropped from tracking rather than removed
    // from Storage — and the next boot would restore the reverted fix.
    const storage = new FakeStorage();
    storage.files.set("state/skill-overlays/drivethru-sanmar.json", "{}");

    const mc = new MemoryCheckpoint({ workspace, storage });
    await mc.restore();
    expect(existsSync(join(workspace, "skill-overlays/drivethru-sanmar.json"))).toBe(true);

    rmSync(join(workspace, "skill-overlays/drivethru-sanmar.json"));
    await mc.checkpoint();
    expect(storage.removes).toContain("state/skill-overlays/drivethru-sanmar.json");
  });

  it("still never writes back console-authored prompts once overlays exist", async () => {
    // The exclusion guard, re-asserted with the third namespace in play: the
    // upload list is exact, so a namespace that leaked would show up here.
    const storage = new FakeStorage();
    writeWs("SOUL.md", "edited locally");
    writeWs("playbook.md", "agent memory");
    writeWs("skill-overlays/x.json", "{}");

    await new MemoryCheckpoint({ workspace, storage }).checkpoint();

    for (const key of CONSOLE_KEYS) expect(storage.files.has(key)).toBe(false);
    expect(storage.uploads).toEqual([
      "memory/playbook.md",
      "state/skill-overlays/x.json",
    ]);
  });
});
