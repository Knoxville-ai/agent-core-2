import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { BundleClient } from "../bundle/client.js";
import type { SkillRequirement } from "../bundle/types.js";
import {
  describeManifestProblem,
  isValidSkillSlug,
  manifestDigest,
  validateManifest,
  type ManifestEntry,
  type ManifestProblem,
  type SyncPlan,
  type SyncPlanLegacySkill,
  type SyncPlanRequest,
  type SyncPlanSkill,
  type SyncResult,
} from "./contract.js";
import {
  listSkillDirs,
  materialize,
  quarantineSkillDir,
  removeSkillDir,
  skillMdPresent,
  SkillContentError,
  stagingDirFor,
  swapIntoPlace,
  sweepScratchDirs,
  validateStagedSkill,
  verifySkillDir,
  workspaceDirs,
  type WorkspaceDirs,
} from "./activate.js";
import { ClawhubSkillResolver } from "./clawhub.js";
import { defaultDepsRunner, extractSkillKey, provisionSkillDepsFor, type DepsRunner } from "./deps.js";
import {
  openclawEligibilityChecker,
  type EligibilityChecker,
  type SkillEligibility,
} from "./eligibility.js";
import { BLOB_FETCH_CONCURRENCY, BlobCache, BlobFetchError, blobCacheDir, mapLimit } from "./fetch.js";
import {
  clearLock,
  entryKeyFor,
  lockDigest,
  readLock,
  revFor,
  writeLock,
  type LockedSkill,
  type SkillLock,
} from "./lock.js";
import { McpSkillSyncPlatform, type SkillSyncPlatform } from "./plan.js";
import { bumpSkillRevs, RefreshGate, type RevChange } from "./refresh.js";
import type { InstalledSkill } from "./resolver.js";

/**
 * SkillSync — the restart-free reconciler that makes `workspace/skills/` match
 * the agent's desired skills in the platform library.
 *
 *   plan    = get_skill_sync_plan({ if_generation, installed })   (broker MCP)
 *   diff    = plan vs. the lock on the volume
 *   install = fetch missing blobs (sha256-verified) → write a fresh staging
 *             folder → check SKILL.md → Python deps → atomic swap → lock
 *   remove  = lock entries the plan dropped
 *   quarantine = folders under skills/ no plan put there (kept, reported)
 *   refresh = bump skills.entries.<key>.config.rev in openclaw.json so every
 *             session rebuilds its skills list on its next turn — no restart
 *             (through the RefreshGate, which holds bumps until the gateway
 *             is watching the file: see ./refresh.ts)
 *   check   = `openclaw skills check --json` → ineligible + what's missing
 *   report  = report_skill_sync
 *
 * One code path for every trigger: `boot` (before the gateway starts), `nudge`
 * (POST /skills/sync from the console) and `poll` (a periodic safety net).
 * Runs are single-flight; triggers that arrive mid-run coalesce into exactly one
 * rerun. Nothing here ever restarts the gateway.
 */

export type SyncTrigger = "boot" | "nudge" | "poll";

/**
 *   unknown  — no plan seen yet (boot couldn't reach the platform)
 *   library  — the console serves get_skill_sync_plan; SkillSync owns skills/
 *   legacy   — the console predates the library: bundle + boot list (ClawHub)
 */
export type SyncMode = "unknown" | "library" | "legacy";

export interface ReconcileOutcome {
  trigger: SyncTrigger;
  /** applied: a plan was applied · unchanged: if_generation matched ·
   *  legacy: the console predates the library · error: no plan (transient). */
  status: "applied" | "unchanged" | "legacy" | "error";
  /** The generation of the plan this run saw (null without a plan). */
  planGeneration: number | null;
  /** lock.generation after the run — advances only when nothing is left to
   *  retry (no transient failures). */
  appliedGeneration: number;
  /** Per-skill results (for `unchanged`: the latest known results). */
  results: SyncResult[];
  /** Folders quarantined this run. */
  unmanaged: string[];
  /** Slugs installed, updated or removed this run. */
  changed: string[];
  /** Some item failed transiently; the generation was not advanced. */
  retryPending: boolean;
  lockDigest: string;
  error?: string;
}

/** Installs a legacy (ClawHub) capability skill — ClawhubSkillResolver. */
export interface LegacyInstaller {
  install(req: SkillRequirement, workspaceSkillsDir: string): Promise<InstalledSkill>;
}

export interface SkillSyncOptions {
  stateDir: string;
  platform: SkillSyncPlatform;
  blobs?: BlobCache;
  depsRunner?: DepsRunner;
  /** null disables the eligibility check. */
  eligibility?: EligibilityChecker | null;
  legacyInstaller?: LegacyInstaller;
  /** Where rev changes go: the process-wide gate that holds them until the
   *  gateway is watching (default: a private gate over bumpSkillRevs). */
  gate?: RefreshGate;
  /** Minimum time between a live refresh write and the run completing, so a
   *  nudge that answers `applied` means the next turn already sees the change
   *  (default REFRESH_SETTLE_MS). */
  refreshSettleMs?: number;
  now?: () => Date;
}

/**
 * How long a live refresh takes to land: the gateway watches openclaw.json
 * (chokidar, 200ms write-stability) and debounces reloads by 300ms; measured
 * ~0.6s from our write to "skills snapshot invalidated" on 2026.5.20. Waiting
 * this long before a run completes makes `POST /skills/sync` → 200 mean the
 * agent's very next turn lists the change.
 */
export const REFRESH_SETTLE_MS = 1_000;

/** A failure that a later sync may fix on its own (download, IO, missing plan
 *  data). Leaves the generation un-advanced so the next poll retries. */
class TransientSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientSyncError";
  }
}

/** Dependency install failed: the version stays inactive, reported `failed`.
 *  Retried when the desired state changes again or at the next boot. */
class DepsInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepsInstallError";
  }
}

/** Manifest problems that make a version unsafe or impossible to materialize.
 *  Size/count limits are the platform's publishing policy, not checked here —
 *  and nothing about the description is (long descriptions are common). */
const BLOCKING_PROBLEMS = new Set<ManifestProblem["code"]>([
  "empty",
  "missing_skill_md",
  "bad_path",
  "duplicate_path",
  "bad_hash",
  "bad_size",
]);

function isTransient(err: unknown): boolean {
  if (err instanceof SkillContentError || err instanceof DepsInstallError) return false;
  return true; // BlobFetchError, TransientSyncError, IO errors, anything unexpected
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function stripUrls(files: SyncPlanSkill["files"]): ManifestEntry[] {
  return (files ?? []).map((f) => ({
    path: f.path,
    sha256: f.sha256,
    size: f.size,
    executable: f.executable,
  }));
}

const TRIGGER_RANK: Record<SyncTrigger, number> = { poll: 0, nudge: 1, boot: 2 };

export class SkillSync {
  readonly stateDir: string;
  private readonly dirs: WorkspaceDirs;
  private readonly platform: SkillSyncPlatform;
  private readonly blobs: BlobCache;
  private readonly depsRunner: DepsRunner;
  private readonly eligibility: EligibilityChecker | null;
  private readonly legacyInstaller: LegacyInstaller;
  private readonly gate: RefreshGate;
  private readonly refreshSettleMs: number;
  private readonly now: () => Date;

  private modeValue: SyncMode = "unknown";
  private current: Promise<ReconcileOutcome> | null = null;
  private pending: Promise<ReconcileOutcome> | null = null;
  private pendingTrigger: SyncTrigger = "poll";
  private lastResults = new Map<string, SyncResult>();
  private eligibilityCache: Map<string, SkillEligibility> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(opts: SkillSyncOptions) {
    this.stateDir = opts.stateDir;
    this.dirs = workspaceDirs(opts.stateDir);
    this.platform = opts.platform;
    this.blobs = opts.blobs ?? new BlobCache({ dir: blobCacheDir(opts.stateDir) });
    this.depsRunner = opts.depsRunner ?? defaultDepsRunner;
    this.eligibility =
      opts.eligibility === undefined
        ? openclawEligibilityChecker({ stateDir: opts.stateDir })
        : opts.eligibility;
    this.legacyInstaller =
      opts.legacyInstaller ?? new ClawhubSkillResolver({ stateDir: opts.stateDir });
    this.gate = opts.gate ?? new RefreshGate((changes) => bumpSkillRevs(opts.stateDir, changes));
    this.refreshSettleMs = opts.refreshSettleMs ?? REFRESH_SETTLE_MS;
    this.now = opts.now ?? (() => new Date());
  }

  get mode(): SyncMode {
    return this.modeValue;
  }

  /**
   * Run a reconcile, or join one: when a run is in flight, exactly one rerun is
   * scheduled after it (shared by every trigger that arrives meanwhile, with the
   * strongest trigger kind) and its promise is returned.
   */
  reconcile(trigger: SyncTrigger): Promise<ReconcileOutcome> {
    if (this.pending) {
      if (TRIGGER_RANK[trigger] > TRIGGER_RANK[this.pendingTrigger]) this.pendingTrigger = trigger;
      return this.pending;
    }
    if (this.current) {
      this.pendingTrigger = trigger;
      this.pending = this.current.then(() => {
        this.pending = null;
        return this.startRun(this.pendingTrigger);
      });
      return this.pending;
    }
    return this.startRun(trigger);
  }

  private startRun(trigger: SyncTrigger): Promise<ReconcileOutcome> {
    const run = this.runOnce(trigger).catch(async (err: unknown): Promise<ReconcileOutcome> => {
      log.error("skill sync crashed", { trigger, err: errorText(err) });
      const { lock } = await readLock(this.stateDir);
      return this.errorOutcome(trigger, errorText(err), lock.generation, lockDigest(lock));
    });
    this.current = run.finally(() => {
      this.current = null;
    });
    return this.current;
  }

  /** Is a reconcile running or queued? */
  get busy(): boolean {
    return this.current !== null || this.pending !== null;
  }

  /**
   * The `/skills/sync` nudge: run or join a reconcile and wait up to `waitMs`
   * for a completed run whose applied generation is ≥ `generation`.
   */
  async syncForNudge(
    generation: number | undefined,
    waitMs: number,
  ): Promise<
    | { kind: "applied"; appliedGeneration: number; results: SyncResult[] }
    | { kind: "in_progress"; generation: number | null; error?: string }
    | { kind: "legacy" }
  > {
    const deadline = Date.now() + waitMs;
    let retried = false;
    let promise = this.reconcile("nudge");
    for (;;) {
      const remaining = deadline - Date.now();
      const outcome = remaining > 0 ? await raceTimeout(promise, remaining) : null;
      if (!outcome) return { kind: "in_progress", generation: generation ?? null };
      if (outcome.status === "legacy") return { kind: "legacy" };
      if (outcome.status === "error") {
        return { kind: "in_progress", generation: generation ?? null, error: outcome.error };
      }
      if (generation === undefined || outcome.appliedGeneration >= generation) {
        return { kind: "applied", appliedGeneration: outcome.appliedGeneration, results: outcome.results };
      }
      // Not there yet. A run that saw an older plan (it started before the
      // console's bump, or read a lagging replica) is worth one more try; a run
      // with transient failures is left to the poll.
      if (outcome.retryPending || retried) {
        return { kind: "in_progress", generation };
      }
      retried = true;
      promise = this.reconcile("nudge");
    }
  }

  /** Start the safety poll (no-op when `intervalMs` ≤ 0). Legacy mode skips
   *  its ticks; only a nudge re-probes the console. */
  startPolling(intervalMs: number): void {
    this.stopPolling();
    if (!(intervalMs > 0)) return;
    this.pollTimer = setInterval(() => {
      if (this.modeValue === "legacy") return;
      void this.reconcile("poll");
    }, intervalMs);
    this.pollTimer.unref?.();
  }

  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** The lock as the `GET /skills` route reports it. */
  async status(): Promise<{
    mode: SyncMode;
    generation: number;
    lock_digest: string;
    skills: Array<{
      slug: string;
      version: string | null;
      content_sha256: string;
      managed_by: string;
      source: string;
      required: boolean;
      status: string;
    }>;
  }> {
    const { lock } = await readLock(this.stateDir);
    return {
      mode: this.modeValue,
      generation: lock.generation,
      lock_digest: lockDigest(lock),
      skills: Object.keys(lock.skills)
        .sort()
        .map((slug) => {
          const e = lock.skills[slug]!;
          return {
            slug,
            version: e.version,
            content_sha256: e.content_sha256,
            managed_by: e.managed_by,
            source: e.source,
            required: e.required,
            status: this.lastResults.get(slug)?.status ?? "installed",
          };
        }),
    };
  }

  /**
   * Of `refs` (capability skill refs from the bundle: a slug, or a library
   * skill id), the ones with nothing on disk to run — matched through the lock
   * (by slug or skill_id) or a folder of that name under skills/.
   */
  async missingRequiredSkills(refs: string[]): Promise<string[]> {
    const { lock } = await readLock(this.stateDir);
    const missing: string[] = [];
    for (const ref of [...new Set(refs)]) {
      const slugs = Object.entries(lock.skills)
        .filter(([slug, e]) => slug === ref || e.skill_id === ref)
        .map(([slug]) => slug);
      if (isValidSkillSlug(ref)) slugs.push(ref);
      let found = false;
      for (const slug of slugs) {
        if (await skillMdPresent(this.dirs, slug)) {
          found = true;
          break;
        }
      }
      if (!found) missing.push(ref);
    }
    return missing;
  }

  /** Forget the lock (legacy mode: the boot list path owns skills/ again). */
  async resetForLegacy(): Promise<void> {
    await clearLock(this.stateDir);
    this.lastResults.clear();
  }

  // -------------------------------------------------------------------------

  private errorOutcome(
    trigger: SyncTrigger,
    error: string,
    appliedGeneration: number,
    digest: string,
  ): ReconcileOutcome {
    return {
      trigger,
      status: "error",
      planGeneration: null,
      appliedGeneration,
      results: [...this.lastResults.values()],
      unmanaged: [],
      changed: [],
      retryPending: true,
      lockDigest: digest,
      error,
    };
  }

  private async runOnce(trigger: SyncTrigger): Promise<ReconcileOutcome> {
    const started = Date.now();
    const timings = { plan_ms: 0, fetch_ms: 0, deps_ms: 0, swap_ms: 0 };
    const loaded = await readLock(this.stateDir);
    const lock = loaded.lock;
    const firstRun = !loaded.existed;
    await sweepScratchDirs(this.dirs);

    // 1. What is actually on disk? Boot re-hashes every library skill against
    //    its manifest (catches a crash between swap and lock write, or a hand
    //    edit); later runs only check SKILL.md is still there.
    const damaged = new Set<string>();
    for (const [slug, entry] of Object.entries(lock.skills)) {
      let ok: boolean;
      if (entry.source === "library") {
        ok =
          trigger === "boot" && entry.files
            ? await verifySkillDir(this.dirs, slug, entry.files)
            : await skillMdPresent(this.dirs, slug);
      } else {
        ok = await pathExists(join(this.dirs.skills, slug));
      }
      if (!ok) damaged.add(slug);
    }
    if (damaged.size > 0) {
      log.warn("skill sync: installed skills don't match the lock; will reinstall", {
        slugs: [...damaged],
      });
    }

    // 2. The plan. `installed` only claims what verified, so the platform sends
    //    files for anything damaged. `if_generation` (cheap no-op) only when the
    //    local state is known-good and this isn't a boot.
    const installed: Record<string, string> = {};
    for (const [slug, entry] of Object.entries(lock.skills)) {
      if (entry.source === "library" && !damaged.has(slug)) installed[slug] = entry.content_sha256;
    }
    const req: SyncPlanRequest = { installed };
    if (trigger !== "boot" && this.modeValue === "library" && loaded.existed && damaged.size === 0) {
      req.if_generation = lock.generation;
    }
    const tPlan = Date.now();
    let fetched;
    try {
      fetched = await this.platform.getSkillSyncPlan(req);
    } catch (err) {
      timings.plan_ms = Date.now() - tPlan;
      log.warn("skill sync: plan fetch failed; keeping the installed skills", {
        trigger,
        err: errorText(err),
      });
      if (trigger === "boot" && loaded.existed) {
        // The venv is part of the image: a fresh container has none of the
        // installed skills' deps even when the platform is unreachable.
        await this.ensureLockedDeps(lock, new Set(), new Map());
        await writeLock(this.stateDir, lock);
        // A lock means this console served the library last time.
        if (this.modeValue === "unknown") this.modeValue = "library";
      }
      return this.errorOutcome(trigger, errorText(err), lock.generation, lockDigest(lock));
    }
    timings.plan_ms = Date.now() - tPlan;
    if (fetched.kind === "legacy") {
      if (this.modeValue !== "legacy") {
        log.info("skill sync: console predates the skills library; using the legacy skills path", {
          detail: fetched.detail.slice(0, 200),
        });
      }
      this.modeValue = "legacy";
      return {
        trigger,
        status: "legacy",
        planGeneration: null,
        appliedGeneration: lock.generation,
        results: [],
        unmanaged: [],
        changed: [],
        retryPending: false,
        lockDigest: lockDigest(lock),
      };
    }
    const switchedFromLegacy = this.modeValue === "legacy";
    this.modeValue = "library";
    const plan = fetched.plan;
    if (plan.unchanged) {
      return {
        trigger,
        status: "unchanged",
        planGeneration: plan.generation,
        appliedGeneration: lock.generation,
        results: [...this.lastResults.values()],
        unmanaged: [],
        changed: [],
        retryPending: false,
        lockDigest: lockDigest(lock),
      };
    }
    if (switchedFromLegacy) {
      log.info("skill sync: console now serves the skills library; switching from legacy mode");
    }

    return await this.apply(trigger, plan, lock, { firstRun, damaged, timings, started });
  }

  private async apply(
    trigger: SyncTrigger,
    plan: SyncPlan,
    lock: SkillLock,
    ctx: {
      firstRun: boolean;
      damaged: Set<string>;
      timings: { plan_ms: number; fetch_ms: number; deps_ms: number; swap_ms: number };
      started: number;
    },
  ): Promise<ReconcileOutcome> {
    const { timings } = ctx;
    const results = new Map<string, SyncResult>();
    const changes: RevChange[] = [];
    const unmanaged: string[] = [];
    const touched = new Set<string>();
    const installedNow: string[] = [];
    const updatedNow: string[] = [];
    const removedNow: string[] = [];
    let transient = 0;

    // De-duplicate the plan (first occurrence wins) and index it.
    const planSkills: SyncPlanSkill[] = [];
    const planSlugs = new Set<string>();
    for (const item of plan.skills ?? []) {
      if (planSlugs.has(item.slug)) {
        log.warn("skill sync: duplicate slug in plan (ignored)", { slug: item.slug });
        continue;
      }
      planSlugs.add(item.slug);
      planSkills.push(item);
    }
    planSkills.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    const legacyItems: SyncPlanLegacySkill[] = [];
    const legacySlugs = new Set<string>();
    for (const item of plan.legacy ?? []) {
      if (planSlugs.has(item.slug) || legacySlugs.has(item.slug)) continue; // library wins
      legacySlugs.add(item.slug);
      legacyItems.push(item);
    }

    // 2. Library skills.
    for (const item of planSkills) {
      const ids = { slug: item.slug, skill_id: item.skill_id || undefined, version_id: item.version_id || undefined };
      if (!isValidSkillSlug(item.slug)) {
        results.set(item.slug, { ...ids, status: "failed", detail: { error: "invalid skill slug" } });
        continue;
      }
      const prev = lock.skills[item.slug];
      const upToDate =
        prev !== undefined &&
        prev.source === "library" &&
        prev.content_sha256 === item.content_sha256 &&
        !ctx.damaged.has(item.slug);
      if (upToDate) {
        // Same bytes; refresh the bookkeeping that can change without a new
        // version (pin ↔ latest, operator ↔ capability, skill key).
        const oldKey = entryKeyFor(item.slug, prev);
        prev.skill_id = item.skill_id || prev.skill_id;
        prev.version_id = item.version_id || prev.version_id;
        prev.version = item.version || prev.version;
        prev.managed_by = item.managed_by;
        prev.required = item.required;
        if (item.skill_key && item.skill_key !== prev.skill_key) {
          prev.skill_key = item.skill_key;
          const newKey = entryKeyFor(item.slug, prev);
          if (newKey !== oldKey) {
            changes.push({ key: oldKey, remove: true }, { key: newKey, rev: revFor(prev.content_sha256) });
          }
        }
        results.set(item.slug, { ...ids, status: "installed" });
        continue;
      }
      try {
        const entry = await this.installLibrarySkill(item, prev, ctx.firstRun, timings, unmanaged);
        lock.skills[item.slug] = entry;
        await writeLock(this.stateDir, lock);
        touched.add(item.slug);
        (prev ? updatedNow : installedNow).push(item.slug);
        const newKey = entryKeyFor(item.slug, entry);
        if (prev && entryKeyFor(item.slug, prev) !== newKey) {
          changes.push({ key: entryKeyFor(item.slug, prev), remove: true });
        }
        changes.push({ key: newKey, rev: revFor(entry.content_sha256) });
        results.set(item.slug, { ...ids, status: "installed" });
      } catch (err) {
        const retry = isTransient(err);
        if (retry) transient += 1;
        log.warn("skill sync: install failed", {
          slug: item.slug,
          version: item.version,
          transient: retry,
          err: errorText(err),
        });
        results.set(item.slug, {
          ...ids,
          status: "failed",
          detail: { error: retry ? `${errorText(err)} (will retry)` : errorText(err) },
        });
      }
    }

    // 4. Legacy (ClawHub) capability skills the library can't resolve yet.
    for (const item of legacyItems) {
      if (!isValidSkillSlug(item.slug)) {
        results.set(item.slug, { slug: item.slug, status: "failed", detail: { error: "unsupported legacy skill slug" } });
        continue;
      }
      const marker = `clawhub:${item.version ?? "latest"}`;
      const prev = lock.skills[item.slug];
      if (prev && prev.source === "clawhub" && prev.content_sha256 === marker && !ctx.damaged.has(item.slug)) {
        prev.required = item.required;
        results.set(item.slug, { slug: item.slug, status: "installed" });
        continue;
      }
      try {
        const entry = await this.installLegacySkill(item, prev, ctx.firstRun, marker, unmanaged, timings);
        lock.skills[item.slug] = entry.locked;
        await writeLock(this.stateDir, lock);
        touched.add(item.slug);
        (prev ? updatedNow : installedNow).push(item.slug);
        if (prev && entryKeyFor(item.slug, prev) !== item.slug) {
          changes.push({ key: entryKeyFor(item.slug, prev), remove: true });
        }
        changes.push({ key: item.slug, rev: revFor(marker) });
        results.set(
          item.slug,
          entry.depsError
            ? { slug: item.slug, status: "failed", detail: { error: `dependency install failed (skill left active): ${entry.depsError}` } }
            : { slug: item.slug, status: "installed" },
        );
      } catch (err) {
        transient += 1;
        log.warn("skill sync: legacy (ClawHub) install failed", { slug: item.slug, err: errorText(err) });
        results.set(item.slug, {
          slug: item.slug,
          status: "failed",
          detail: { error: `${errorText(err)} (will retry)` },
        });
      }
    }

    // 3. Removals: locked skills the plan no longer lists.
    for (const slug of Object.keys(lock.skills).sort()) {
      if (planSlugs.has(slug) || legacySlugs.has(slug)) continue;
      const entry = lock.skills[slug]!;
      try {
        await removeSkillDir(this.dirs, slug);
      } catch (err) {
        transient += 1;
        log.warn("skill sync: remove failed", { slug, err: errorText(err) });
        continue;
      }
      delete lock.skills[slug];
      await writeLock(this.stateDir, lock);
      changes.push({ key: entryKeyFor(slug, entry), remove: true });
      removedNow.push(slug);
      results.set(slug, {
        slug,
        ...(entry.skill_id ? { skill_id: entry.skill_id } : {}),
        ...(entry.version_id ? { version_id: entry.version_id } : {}),
        status: "removed",
      });
    }

    // 5. Folders nobody put there (hand-written, or a pre-library ClawHub
    //    install): quarantine — never delete. A plan slug whose install failed
    //    keeps its pre-existing folder until an install succeeds.
    for (const name of await listSkillDirs(this.dirs)) {
      if (lock.skills[name] || planSlugs.has(name) || legacySlugs.has(name)) continue;
      try {
        const dest = await quarantineSkillDir(this.dirs, name);
        unmanaged.push(name);
        changes.push({ key: name, remove: true });
        log.warn("skill sync: quarantined an unmanaged skill folder", { name, to: dest });
      } catch (err) {
        log.warn("skill sync: quarantine failed", { name, err: errorText(err) });
      }
    }

    // Deps of the live skills not touched above: hash-skipped when this venv
    // already has them, so this is a SKILL.md read per skill — except after a
    // container restart (the venv lives in the image, so a fresh container has
    // none of them) or after an earlier failure, which this retries.
    const depsFailures = new Map<string, string>();
    {
      const t = Date.now();
      await this.ensureLockedDeps(lock, touched, depsFailures);
      timings.deps_ms += Date.now() - t;
      for (const [slug, error] of depsFailures) {
        const r = results.get(slug);
        if (r && r.status === "installed") {
          results.set(slug, { ...r, status: "failed", detail: { error: `dependency install failed (skill left active): ${error}` } });
        }
      }
    }

    // Generation: advance only when nothing is left to retry.
    if (transient === 0) lock.generation = plan.generation;
    await writeLock(this.stateDir, lock);

    // 6. Tell the gateway. Before it is up and watching (boot, or a nudge
    //    during startup) the gate queues the change for its post-start flush;
    //    the final boot config write already carries the lock's revs.
    let refreshedAt: number | null = null;
    if (changes.length > 0) {
      try {
        if ((await this.gate.push(changes)).live) refreshedAt = Date.now();
      } catch (err) {
        log.error("skills refresh failed; sessions see the change on their next skills.* update", {
          err: errorText(err),
        });
      }
    }

    // 7. Eligibility (one CLI call covers every skill). Re-checked when
    //    something changed, at boot, or when nothing is cached yet.
    const anythingChanged = installedNow.length + updatedNow.length + removedNow.length + unmanaged.length > 0;
    if (this.eligibility && (anythingChanged || trigger === "boot" || !this.eligibilityCache)) {
      const checked = await this.eligibility();
      if (checked) this.eligibilityCache = checked;
    }
    if (this.eligibilityCache) {
      for (const [slug, r] of results) {
        if (r.status !== "installed") continue;
        const e = this.eligibilityCache.get(slug);
        if (!e || e.eligible) continue;
        const extra = [
          e.missing_config.length ? `missing config: ${e.missing_config.join(", ")}` : "",
          e.missing_os.length ? `unsupported OS (needs ${e.missing_os.join(", ")})` : "",
        ].filter(Boolean);
        results.set(slug, {
          ...r,
          status: "ineligible",
          detail: {
            missing_env: e.missing_env,
            missing_bins: e.missing_bins,
            ...(extra.length ? { error: extra.join("; ") } : {}),
          },
        });
      }
    }

    // 8. Blob GC once fully converged: keep what the lock and this plan use.
    if (transient === 0) {
      const keep = new Set<string>();
      for (const e of Object.values(lock.skills)) for (const f of e.files ?? []) keep.add(f.sha256);
      for (const item of planSkills) for (const f of item.files ?? []) keep.add(f.sha256);
      const removed = await this.blobs.gc(keep);
      if (removed > 0) log.info("skill blob cache trimmed", { removed });
    }

    // Let the gateway apply the refresh before this run counts as done.
    if (refreshedAt !== null) {
      const wait = this.refreshSettleMs - (Date.now() - refreshedAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }

    const resultList = [...results.values()];
    this.lastResults = new Map(resultList.filter((r) => r.status !== "removed").map((r) => [r.slug, r]));
    const digest = lockDigest(lock);
    await this.platform.reportSkillSync({
      generation: lock.generation,
      results: resultList,
      ...(unmanaged.length ? { unmanaged } : {}),
      lock_digest: digest,
    });

    log.info("skill sync", {
      trigger,
      generation: plan.generation,
      applied_generation: lock.generation,
      installed: installedNow,
      updated: updatedNow,
      removed: removedNow,
      failed: resultList.filter((r) => r.status === "failed").map((r) => r.slug),
      ineligible: resultList.filter((r) => r.status === "ineligible").map((r) => r.slug),
      unmanaged,
      retry_pending: transient > 0,
      refreshed: refreshedAt !== null,
      ...timings,
      total_ms: Date.now() - ctx.started,
    });

    return {
      trigger,
      status: "applied",
      planGeneration: plan.generation,
      appliedGeneration: lock.generation,
      results: resultList,
      unmanaged,
      changed: [...installedNow, ...updatedNow, ...removedNow],
      retryPending: transient > 0,
      lockDigest: digest,
    };
  }

  /** Fetch → stage → validate → deps → swap one library skill. Returns the
   *  new lock entry; throws (old version stays live) on any failure. */
  private async installLibrarySkill(
    item: SyncPlanSkill,
    prev: LockedSkill | undefined,
    firstRun: boolean,
    timings: { fetch_ms: number; deps_ms: number; swap_ms: number },
    unmanaged: string[],
  ): Promise<LockedSkill> {
    if (!item.files) {
      throw new TransientSyncError("the plan sent no files for a changed skill");
    }
    const manifest = stripUrls(item.files);
    const problems = validateManifest(manifest).filter((p) => BLOCKING_PROBLEMS.has(p.code));
    if (problems.length > 0) {
      throw new SkillContentError(`invalid manifest: ${problems.map(describeManifestProblem).join("; ")}`);
    }
    if (manifestDigest(manifest) !== item.content_sha256) {
      throw new SkillContentError("manifest digest does not match content_sha256");
    }

    const tFetch = Date.now();
    await mapLimit(item.files, BLOB_FETCH_CONCURRENCY, (f) => this.blobs.ensure(f.sha256, f.url, f.size));
    timings.fetch_ms += Date.now() - tFetch;

    const staged = stagingDirFor(this.dirs, item.slug, item.content_sha256);
    try {
      await materialize(manifest, staged, this.blobs);
      const { frontmatter } = await validateStagedSkill(staged, item.slug);

      const tDeps = Date.now();
      const deps = await provisionSkillDepsFor(staged, {
        previousHash: prev?.deps_hash ?? null,
        runner: this.depsRunner,
        label: item.slug,
      });
      timings.deps_ms += Date.now() - tDeps;
      if (!deps.ok) throw new DepsInstallError(`dependency install failed: ${deps.error ?? "unknown error"}`);

      const tSwap = Date.now();
      // A folder already at skills/<slug> that the lock doesn't own is someone
      // else's work: keep it (quarantine) — except on the first library-mode
      // run, where it is the pre-library install of this same skill.
      const live = join(this.dirs.skills, item.slug);
      const preserveExisting = !prev && !firstRun && (await pathExists(live));
      const swap = await swapIntoPlace(this.dirs, item.slug, staged, { preserveExisting });
      timings.swap_ms += Date.now() - tSwap;
      if (swap.quarantinedTo) unmanaged.push(item.slug);

      return {
        skill_id: item.skill_id || null,
        version_id: item.version_id || null,
        version: item.version || null,
        content_sha256: item.content_sha256,
        skill_key: item.skill_key ?? extractSkillKey(frontmatter),
        managed_by: item.managed_by,
        required: item.required,
        source: "library",
        deps_hash: deps.hash,
        installed_at: this.now().toISOString(),
        files: manifest,
      };
    } finally {
      await rm(staged, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Install a legacy capability skill from ClawHub into skills/<slug>. */
  private async installLegacySkill(
    item: SyncPlanLegacySkill,
    prev: LockedSkill | undefined,
    firstRun: boolean,
    marker: string,
    unmanaged: string[],
    timings: { deps_ms: number },
  ): Promise<{ locked: LockedSkill; depsError?: string }> {
    const live = join(this.dirs.skills, item.slug);
    if (!prev && !firstRun && (await pathExists(live))) {
      await quarantineSkillDir(this.dirs, item.slug);
      unmanaged.push(item.slug);
    }
    const installed = await this.legacyInstaller.install(
      { source: "clawhub", ref: item.slug, version: item.version ?? "" },
      this.dirs.skills,
    );
    const tDeps = Date.now();
    const deps = await provisionSkillDepsFor(installed.path, {
      previousHash: prev?.deps_hash ?? null,
      runner: this.depsRunner,
      label: item.slug,
    });
    timings.deps_ms += Date.now() - tDeps;
    return {
      locked: {
        skill_id: null,
        version_id: null,
        version: item.version,
        content_sha256: marker,
        skill_key: null,
        managed_by: "capability",
        required: item.required,
        source: "clawhub",
        deps_hash: deps.ok ? deps.hash : null,
        installed_at: this.now().toISOString(),
      },
      ...(deps.ok ? {} : { depsError: deps.error ?? "unknown error" }),
    };
  }

  /** (Re-)provision deps for locked skills not touched this run. A failure
   *  leaves the skill active and is reported against it. */
  private async ensureLockedDeps(
    lock: SkillLock,
    skip: Set<string>,
    failures: Map<string, string>,
  ): Promise<void> {
    for (const slug of Object.keys(lock.skills).sort()) {
      if (skip.has(slug)) continue;
      const entry = lock.skills[slug]!;
      const dir = join(this.dirs.skills, slug);
      if (!(await pathExists(dir))) continue;
      const deps = await provisionSkillDepsFor(dir, {
        previousHash: entry.deps_hash,
        runner: this.depsRunner,
        label: slug,
      });
      if (deps.ok) {
        entry.deps_hash = deps.hash;
      } else {
        entry.deps_hash = null;
        failures.set(slug, deps.error ?? "unknown error");
        log.error("skill deps failed for an installed skill (left active)", { slug, err: deps.error });
      }
    }
  }
}

/** Resolve to the promise's value, or null if `ms` passes first. */
async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The plan client needs more headroom than a bundle fetch: the console signs
 *  one download URL per changed file. */
const PLAN_TIMEOUT_MS = 30_000;

/** Build the SkillSync for this vessel, or null when the platform MCP isn't
 *  configured (no library — the legacy boot-list path is all there is). */
export function skillSyncFromEnv(env: AgentEnv, gate: RefreshGate): SkillSync | null {
  if (!env.PLATFORM_MCP_URL || !env.PLATFORM_API_TOKEN) return null;
  const client = new BundleClient({
    url: env.PLATFORM_MCP_URL,
    token: env.PLATFORM_API_TOKEN,
    timeoutMs: PLAN_TIMEOUT_MS,
  });
  return new SkillSync({
    stateDir: env.OPENCLAW_STATE_DIR,
    platform: new McpSkillSyncPlatform(client),
    gate,
  });
}
