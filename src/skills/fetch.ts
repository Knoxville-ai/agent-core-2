import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { log } from "../log.js";
import { isSha256, sha256Hex } from "./contract.js";

/**
 * Content-addressed blob cache: `$OPENCLAW_STATE_DIR/skill-blobs/<aa>/<sha256>`.
 *
 * A skill version is a manifest of files, each stored once on the platform under
 * its sha256; the sync plan hands the vessel a short-lived signed URL per file.
 * The cache downloads a body only when it isn't already on the volume, verifies
 * the bytes hash to the name it was asked for (a mismatch is rejected and never
 * cached), and writes atomically — so everything in the cache is trusted content
 * and an update re-downloads only the files that actually changed.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONCURRENCY = 6;

/** A download that didn't produce the expected bytes: network/HTTP failure,
 *  timeout, size or sha256 mismatch. Retried on the next sync. */
export class BlobFetchError extends Error {
  constructor(
    public readonly sha256: string,
    detail: string,
  ) {
    super(`blob ${sha256.slice(0, 12)}…: ${detail}`);
    this.name = "BlobFetchError";
  }
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface BlobCacheOptions {
  /** Cache root, normally `$OPENCLAW_STATE_DIR/skill-blobs`. */
  dir: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export function blobCacheDir(stateDir: string): string {
  return join(stateDir, "skill-blobs");
}

export class BlobCache {
  readonly dir: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  /** In-flight downloads, so the same body is fetched once per run. */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(opts: BlobCacheOptions) {
    this.dir = opts.dir;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  pathFor(sha256: string): string {
    if (!isSha256(sha256)) throw new BlobFetchError(sha256, "not a sha256");
    return join(this.dir, sha256.slice(0, 2), sha256);
  }

  async has(sha256: string): Promise<boolean> {
    try {
      return (await stat(this.pathFor(sha256))).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Make sure the body for `sha256` is cached, downloading it from `url` only
   * when missing. Resolves to the cached path; rejects with BlobFetchError when
   * the download fails or the bytes don't hash to `sha256` (nothing is cached).
   */
  ensure(sha256: string, url: string, expectedSize?: number): Promise<string> {
    const running = this.inflight.get(sha256);
    if (running) return running;
    const p = this.ensureOnce(sha256, url, expectedSize).finally(() => {
      this.inflight.delete(sha256);
    });
    this.inflight.set(sha256, p);
    return p;
  }

  private async ensureOnce(sha256: string, url: string, expectedSize?: number): Promise<string> {
    const path = this.pathFor(sha256);
    if (await this.has(sha256)) return path;
    const bytes = await this.download(sha256, url, expectedSize);
    await mkdir(join(this.dir, sha256.slice(0, 2)), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    const fh = await open(tmp, "wx", 0o644);
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    return path;
  }

  private async download(sha256: string, url: string, expectedSize?: number): Promise<Buffer> {
    if (typeof url !== "string" || url === "") {
      throw new BlobFetchError(sha256, "no download URL in the plan");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let bytes: Buffer;
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { signal: controller.signal });
      } catch (err) {
        throw new BlobFetchError(sha256, `download failed: ${String(err)}`);
      }
      if (!res.ok) {
        throw new BlobFetchError(sha256, `download failed: HTTP ${res.status}`);
      }
      try {
        bytes = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        throw new BlobFetchError(sha256, `download interrupted: ${String(err)}`);
      }
    } finally {
      clearTimeout(timer);
    }
    if (expectedSize !== undefined && bytes.length !== expectedSize) {
      throw new BlobFetchError(sha256, `size mismatch (got ${bytes.length}, manifest says ${expectedSize})`);
    }
    const actual = sha256Hex(bytes);
    if (actual !== sha256) {
      throw new BlobFetchError(sha256, `sha256 mismatch (got ${actual.slice(0, 12)}…)`);
    }
    return bytes;
  }

  /**
   * Read a cached body, re-verifying its hash (defense in depth against a
   * corrupted volume). A bad copy is deleted so the next sync re-fetches it.
   */
  async read(sha256: string): Promise<Buffer> {
    const path = this.pathFor(sha256);
    const bytes = await readFile(path);
    if (sha256Hex(bytes) !== sha256) {
      await rm(path, { force: true }).catch(() => {});
      throw new BlobFetchError(sha256, "cached copy is corrupt (removed; will re-fetch)");
    }
    return bytes;
  }

  /** Delete every cached body (and stray tmp file) not in `keep`. Returns how
   *  many files were removed. Never throws. */
  async gc(keep: Set<string>): Promise<number> {
    let removed = 0;
    let shards: string[];
    try {
      shards = await readdir(this.dir);
    } catch {
      return 0;
    }
    for (const shard of shards) {
      const shardDir = join(this.dir, shard);
      let names: string[];
      try {
        names = await readdir(shardDir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (keep.has(name)) continue;
        try {
          await rm(join(shardDir, name), { force: true, recursive: true });
          removed += 1;
        } catch (err) {
          log.warn("skill blob gc: remove failed", { name, err: String(err) });
        }
      }
      try {
        if ((await readdir(shardDir)).length === 0) await rm(shardDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    return removed;
  }
}

/** Run `fn` over `items` with at most `limit` in flight; rejects with the first
 *  error after every started task settles. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let firstError: unknown = null;
  const worker = async (): Promise<void> => {
    while (next < items.length && firstError === null) {
      const i = next++;
      try {
        results[i] = await fn(items[i]!);
      } catch (err) {
        if (firstError === null) firstError = err;
      }
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  if (firstError !== null) throw firstError;
  return results;
}

export const BLOB_FETCH_CONCURRENCY = DEFAULT_CONCURRENCY;
