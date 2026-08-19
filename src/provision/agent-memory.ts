import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { AgentStorage } from "./supabase-storage.js";

/**
 * Milestone 2 — durable, portable agent memory.
 *
 * The M1 Railway volume keeps openclaw's session/memory across normal restarts,
 * but it does NOT survive a re-provision onto a NEW service (the volume doesn't
 * follow), disaster recovery, or give the console visibility. This module mirrors
 * the agent's OWN markdown to Supabase Storage on a per-turn checkpoint, and
 * restores it on boot — the durability layer the volume can't provide.
 *
 * HARD GUARDRAIL: write-back is scoped to AGENT-OWNED files only. The
 * console-authored prompts (memory/system_prompt.md, memory/identity.md,
 * memory/boot.md → SOUL/AGENTS/TOOLS) are NEVER written back; boot re-renders
 * them from Storage. The only keys this module ever uploads or deletes are the
 * two agent-owned ones below, and `isAgentOwned()` is asserted before any delete.
 *
 *   workspace/playbook.md   ↔  memory/playbook.md   (agent-writable; console may seed)
 *   workspace/notes/<x>.md  ↔  state/notes/<x>.md   (agent-authored; reserved state/ ns)
 */

const MD_CONTENT_TYPE = "text/markdown";
const JSON_CONTENT_TYPE = "application/json";

// Agent-owned single file: the playbook (already downloaded by boot today).
const PLAYBOOK_LOCAL = "playbook.md"; // relative to workspace/
const PLAYBOOK_STORAGE = "memory/playbook.md";

// Agent-authored notes namespace (new). Lives under the reserved `state/`
// prefix so it can never collide with the console's `memory/` prompts.
const NOTES_LOCAL_DIR = "notes"; // workspace/notes/
const NOTES_STORAGE_PREFIX = "state/notes";

// Agent-authored SKILL OVERLAYS: learned selector fixes, one JSON file per
// skill slug. Also under the reserved `state/` prefix.
//
// This is what makes a repair outlive the container. `workspace/skills/` is
// wiped and reinstalled from ClawHub on every boot, so a fix written into a
// skill's own files lasts exactly until the next restart. Overlays live in a
// SIBLING directory that the wipe never touches, and are re-applied by the
// skill itself at import.
//
// Flat — one file per slug, not a tree. `listMarkdown` is non-recursive and
// AgentStorage.list has an unpaginated ceiling, so a nested layout would mean
// new storage plumbing and a new fake in every test for no gain: the overlay is
// a small key→selector map, which is one file's worth of content.
const OVERLAYS_LOCAL_DIR = "skill-overlays"; // workspace/skill-overlays/
const OVERLAYS_STORAGE_PREFIX = "state/skill-overlays";

/** Subset of AgentStorage that MemoryCheckpoint needs — lets tests inject a fake. */
export interface StorageLike {
  downloadText(rel: string): Promise<string | null>;
  uploadText(rel: string, body: string, contentType: string): Promise<void>;
  list(rel: string): Promise<string[]>;
  remove(rel: string): Promise<void>;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  return (await readFileOrNull(path)) != null;
}

/** Flat list of basenames with `suffix` directly under a dir; [] if absent. */
async function listFiles(dir: string, suffix: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(suffix))
    .map((e) => e.name);
}

/** Flat list of `*.md` basenames directly under a dir; [] if the dir is absent. */
async function listMarkdown(dir: string): Promise<string[]> {
  return listFiles(dir, ".md");
}

/** Content type for a storage key, since uploads are not all markdown now. */
function contentTypeFor(storageKey: string): string {
  return storageKey.endsWith(".json") ? JSON_CONTENT_TYPE : MD_CONTENT_TYPE;
}

export class MemoryCheckpoint {
  private readonly workspace: string;
  private readonly storage: StorageLike;
  /** storageKey → sha256 of what Storage is believed to currently hold. */
  private hashes = new Map<string, string>();
  private running = false;
  private dirty = false;

  constructor(opts: { workspace: string; storage: StorageLike }) {
    this.workspace = opts.workspace;
    this.storage = opts.storage;
  }

  static fromEnv(env: AgentEnv): MemoryCheckpoint {
    return new MemoryCheckpoint({
      workspace: join(env.OPENCLAW_STATE_DIR, "workspace"),
      storage: new AgentStorage(env),
    });
  }

  private isAgentOwned(storageKey: string): boolean {
    return (
      storageKey === PLAYBOOK_STORAGE ||
      storageKey.startsWith(`${NOTES_STORAGE_PREFIX}/`) ||
      storageKey.startsWith(`${OVERLAYS_STORAGE_PREFIX}/`)
    );
  }

  /** Map of agent-owned storageKey → current on-disk contents. */
  private async scanLocal(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const pb = await readFileOrNull(join(this.workspace, PLAYBOOK_LOCAL));
    if (pb != null) out.set(PLAYBOOK_STORAGE, pb);
    const notesDir = join(this.workspace, NOTES_LOCAL_DIR);
    for (const name of await listMarkdown(notesDir)) {
      const contents = await readFileOrNull(join(notesDir, name));
      if (contents != null) out.set(`${NOTES_STORAGE_PREFIX}/${name}`, contents);
    }
    const overlaysDir = join(this.workspace, OVERLAYS_LOCAL_DIR);
    for (const name of await listFiles(overlaysDir, ".json")) {
      const contents = await readFileOrNull(join(overlaysDir, name));
      if (contents != null) out.set(`${OVERLAYS_STORAGE_PREFIX}/${name}`, contents);
    }
    return out;
  }

  /**
   * Boot restore with precedence: the VOLUME copy wins when present (live
   * state); fall back to the Supabase copy only when the file is absent (fresh
   * container / re-provisioned service / empty volume). Never overwrites a
   * present local copy. Seeds the hash map from STORAGE contents so the first
   * checkpoint is a no-op for files already mirrored, but still uploads a
   * volume copy that diverges from (or is missing in) Storage.
   */
  async restore(): Promise<void> {
    const seeded = new Map<string, string>();
    await this.restoreOne(
      PLAYBOOK_STORAGE,
      join(this.workspace, PLAYBOOK_LOCAL),
      seeded,
    );
    for (const name of await this.storage.list(NOTES_STORAGE_PREFIX)) {
      if (!name.endsWith(".md")) continue;
      await this.restoreOne(
        `${NOTES_STORAGE_PREFIX}/${name}`,
        join(this.workspace, NOTES_LOCAL_DIR, name),
        seeded,
      );
    }
    for (const name of await this.storage.list(OVERLAYS_STORAGE_PREFIX)) {
      if (!name.endsWith(".json")) continue;
      await this.restoreOne(
        `${OVERLAYS_STORAGE_PREFIX}/${name}`,
        join(this.workspace, OVERLAYS_LOCAL_DIR, name),
        seeded,
      );
    }
    this.hashes = seeded;
    log.info("agent memory restored", { tracked: this.hashes.size });
  }

  private async restoreOne(
    storageKey: string,
    localPath: string,
    seeded: Map<string, string>,
  ): Promise<void> {
    const remote = await this.storage.downloadText(storageKey);
    if (await fileExists(localPath)) {
      // Volume wins: keep the local copy untouched. Seed with the Storage hash
      // (if any) so a divergent/newer local copy gets pushed up on the next
      // checkpoint; a local copy with no Storage counterpart stays unseeded and
      // uploads on the next checkpoint.
      if (remote != null) seeded.set(storageKey, sha256(remote));
      return;
    }
    if (remote != null) {
      await mkdir(dirname(localPath), { recursive: true });
      await writeFile(localPath, remote, "utf8");
      seeded.set(storageKey, sha256(remote));
    }
  }

  /**
   * Mirror agent-owned markdown to Storage. Coalesced: a call that arrives
   * while another is running just marks the run dirty so it repeats once more,
   * so concurrent turns across conversations never race on Storage. Never
   * throws — a failed upload is logged and retried on the next turn / SIGTERM
   * flush (the M1 volume still holds the bytes meanwhile).
   */
  async checkpoint(): Promise<void> {
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.dirty = false;
        await this.runOnce();
      } while (this.dirty);
    } catch (err) {
      log.warn("agent memory checkpoint failed", { err: String(err) });
    } finally {
      this.running = false;
    }
  }

  /** SIGTERM backstop — flush the final state before the container stops. */
  async flush(): Promise<void> {
    await this.checkpoint();
  }

  private async runOnce(): Promise<void> {
    const local = await this.scanLocal();

    // Uploads: only changed/new agent-owned files.
    for (const [key, contents] of local) {
      const h = sha256(contents);
      if (this.hashes.get(key) === h) continue; // unchanged → echo-avoided
      try {
        await this.storage.uploadText(key, contents, contentTypeFor(key));
        this.hashes.set(key, h);
        log.info("agent memory uploaded", { key });
      } catch (err) {
        log.warn("agent memory upload failed", { key, err: String(err) });
      }
    }

    // Deletions: tracked keys with no local file, mirrored to Storage. Scoped
    // strictly to agent-owned keys (defensive — every tracked key already is).
    for (const key of [...this.hashes.keys()]) {
      if (local.has(key)) continue;
      if (!this.isAgentOwned(key)) {
        this.hashes.delete(key);
        continue;
      }
      try {
        await this.storage.remove(key);
        this.hashes.delete(key);
        log.info("agent memory deleted", { key });
      } catch (err) {
        log.warn("agent memory delete failed", { key, err: String(err) });
      }
    }
  }
}
