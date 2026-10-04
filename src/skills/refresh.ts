import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { log } from "../log.js";
import { writeFileAtomic } from "./lock.js";

/**
 * Make a running gateway see a skills change on the NEXT turn, without a
 * restart.
 *
 * On the pinned OpenClaw (2026.5.20) the OpenAI-compatible path the shim uses
 * never starts the skills file watcher, so a new/changed/removed folder under
 * `workspace/skills/` is invisible to existing sessions — until any config key
 * under `skills.*` changes. The gateway hot-reloads `openclaw.json` and, for any
 * `skills.*` path, bumps the skills snapshot version, so every session rebuilds
 * its skills list from disk on its next turn (verified live; design doc §5).
 * `gateway.reload.mode: "hot"` (set by buildOpenclawConfig) guarantees the edit
 * is applied in-process and never restarts the gateway.
 *
 * The trigger is a per-skill revision, `skills.entries.<key>.config.rev` — a
 * free-form bag the schema allows — so a content change always changes a
 * `skills.*` path. `<key>` is `metadata.openclaw.skillKey` when the skill sets
 * one, else its slug. Everything else in the file is preserved.
 *
 * When a change touches no entry of its own (a removed skill that never had an
 * entry, a quarantined hand-made folder, the post-start flush), the rev of one
 * dedicated entry, `skills.entries["knox-skillsync"]`, is bumped instead, so the
 * write still changes a `skills.*` path. No skill has that key; OpenClaw only
 * reads an entry for the skill whose key it is.
 */

/** The entry bumped when a refresh must happen but changes no skill's own entry. */
export const REFRESH_SENTINEL_KEY = "knox-skillsync";

export type RevChange =
  /** Set `skills.entries[key].config.rev = rev` (install / update). */
  | { key: string; rev: string }
  /** The skill is gone: drop our rev (and the entry, when the rev was all it
   *  held). */
  | { key: string; remove: true };

/** A fresh random rev (12 hex), for changes with no content digest. */
export function freshRev(): string {
  return randomBytes(6).toString("hex");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** True when `entry` is exactly `{ config: { rev } }` — nothing but our rev. */
export function isRevOnlyEntry(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  const keys = Object.keys(entry);
  if (keys.length !== 1 || keys[0] !== "config") return false;
  const config = entry.config;
  if (!isRecord(config)) return false;
  const ck = Object.keys(config);
  return ck.length === 1 && ck[0] === "rev";
}

/** `config.skills.entries`, created on demand (only when `create`). */
function skillsEntries(config: Record<string, unknown>, create: boolean): Record<string, unknown> | null {
  if (!isRecord(config.skills)) {
    if (!create) return null;
    config.skills = {};
  }
  const skills = config.skills as Record<string, unknown>;
  if (!isRecord(skills.entries)) {
    if (!create) return null;
    skills.entries = {};
  }
  return skills.entries as Record<string, unknown>;
}

function setRev(config: Record<string, unknown>, key: string, rev: string): void {
  const entries = skillsEntries(config, true)!;
  const entry = isRecord(entries[key]) ? (entries[key] as Record<string, unknown>) : {};
  const cfg = isRecord(entry.config) ? entry.config : {};
  cfg.rev = rev;
  entry.config = cfg;
  entries[key] = entry;
}

/**
 * Apply rev changes to a parsed openclaw.json object IN PLACE. With
 * `ensureChange`, a call that would otherwise leave the `skills` block as it was
 * bumps the sentinel entry. Returns whether the `skills` block changed.
 */
export function applyRevChanges(
  config: Record<string, unknown>,
  changes: RevChange[],
  opts: { ensureChange?: boolean } = {},
): boolean {
  const before = structuredClone(config.skills ?? null);
  for (const change of changes) {
    if ("rev" in change) {
      setRev(config, change.key, change.rev);
      continue;
    }
    const entries = skillsEntries(config, false);
    const entry = entries?.[change.key];
    if (!entries || entry === undefined) continue;
    if (isRevOnlyEntry(entry)) {
      delete entries[change.key];
    } else if (isRecord(entry) && isRecord(entry.config) && "rev" in entry.config) {
      delete entry.config.rev;
      if (Object.keys(entry.config).length === 0) delete entry.config;
    }
  }
  if (opts.ensureChange && isDeepStrictEqual(before, config.skills ?? null)) {
    setRev(config, REFRESH_SENTINEL_KEY, freshRev());
  }
  return !isDeepStrictEqual(before, config.skills ?? null);
}

/** openclaw.json in the state dir — the file the gateway was started with. */
export function openclawConfigPath(stateDir: string): string {
  return join(stateDir, "openclaw.json");
}

/** Serializes config writes within this process (refresh vs. legacy routes). */
let chain: Promise<unknown> = Promise.resolve();

/**
 * Read openclaw.json, apply `changes`, and write it back (tmp + rename), with
 * the boot writer's formatting (`JSON.stringify(config, null, 2)`) and every
 * other key untouched. Non-empty `changes` always produce a `skills.*` change
 * (see the sentinel) unless `ensureChange: false`; an unchanged block is never
 * rewritten.
 */
export function bumpSkillRevs(
  stateDir: string,
  changes: RevChange[],
  opts: { ensureChange?: boolean } = {},
): Promise<{ changed: boolean }> {
  const run = async (): Promise<{ changed: boolean }> => {
    if (changes.length === 0) return { changed: false };
    const path = openclawConfigPath(stateDir);
    const config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (!applyRevChanges(config, changes, { ensureChange: opts.ensureChange ?? true })) {
      return { changed: false };
    }
    await writeFileAtomic(path, JSON.stringify(config, null, 2));
    log.info("skills refresh: openclaw.json skills.entries updated", {
      changes: changes.map((c) => ("rev" in c ? `${c.key}=${c.rev}` : `-${c.key}`)),
    });
    return { changed: true };
  };
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}

/**
 * Gate between "change a skill" and "tell the gateway". The gateway attaches
 * its openclaw.json watcher only once it reports ready (`/readyz` → 200); a rev
 * bump written before that is missed (verified on 2026.5.20). So until `open()`
 * changes are queued, and `open()` flushes them as ONE write that is
 * guaranteed to change a `skills.*` path.
 *
 * Opening with `force` also bumps when nothing is queued. index.ts does that on
 * every start as a cheap guarantee for sessions resumed from the volume: a
 * session's skills snapshot is persisted with it, a fresh gateway starts at
 * snapshot version 0, and openclaw reuses a snapshot that was built at version
 * 0 (`shouldRefreshSnapshotForVersion(0, 0)` is false). On 2026.5.20 the shim's
 * `webchat:<id>` sessions happen to be re-keyed at gateway start and rebuild
 * anyway (observed); the forced bump keeps that true if the re-keying changes.
 *
 * One gate per process, shared by SkillSync and the deprecated
 * `/skills/install` + `DELETE /skills/:slug` routes.
 */
export class RefreshGate {
  private opened = false;
  private queued: RevChange[] = [];

  constructor(private readonly write: (changes: RevChange[]) => Promise<unknown>) {}

  /** True once the gateway is watching (changes are written immediately). */
  get isOpen(): boolean {
    return this.opened;
  }

  /** Write now if the gateway is watching (`live: true`), else queue. */
  async push(changes: RevChange[]): Promise<{ live: boolean }> {
    if (changes.length === 0) return { live: false };
    if (!this.opened) {
      this.queued.push(...changes);
      return { live: false };
    }
    await this.write(changes);
    return { live: true };
  }

  /** The gateway is up and watching: flush what queued up (or, with `force`,
   *  bump the sentinel even when nothing did). Returns whether it wrote. */
  async open(opts: { force?: boolean } = {}): Promise<boolean> {
    this.opened = true;
    const queued = this.queued;
    this.queued = [];
    if (queued.length === 0 && !opts.force) return false;
    await this.write(queued.length > 0 ? queued : [{ key: REFRESH_SENTINEL_KEY, rev: freshRev() }]);
    return true;
  }
}
