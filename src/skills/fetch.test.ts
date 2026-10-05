import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256Hex } from "./contract.js";
import { BlobCache, BlobFetchError, mapLimit, type FetchLike } from "./fetch.js";

/** A fake blob server: url → body (or status). Counts requests. */
function fakeFetch(routes: Record<string, string | number>): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (r === undefined) throw new Error("ECONNREFUSED");
    if (typeof r === "number") return new Response("nope", { status: r });
    return new Response(r, { status: 200 });
  };
  return { fetch, calls };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "knox-blobs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("BlobCache.ensure", () => {
  it("downloads a missing blob once, verifies it, stores it under <aa>/<sha>", async () => {
    const body = "hello blob";
    const sha = sha256Hex(body);
    const { fetch, calls } = fakeFetch({ "https://x/b1": body });
    const cache = new BlobCache({ dir, fetch });

    const path = await cache.ensure(sha, "https://x/b1", Buffer.byteLength(body));
    expect(path).toBe(join(dir, sha.slice(0, 2), sha));
    expect(await readFile(path, "utf8")).toBe(body);

    // Cached: a second ensure never hits the network.
    await cache.ensure(sha, "https://x/b1");
    expect(calls).toEqual(["https://x/b1"]);
    // No temp files left next to it.
    expect(await readdir(join(dir, sha.slice(0, 2)))).toEqual([sha]);
  });

  it("de-duplicates concurrent ensures of the same blob", async () => {
    const body = "same";
    const sha = sha256Hex(body);
    const { fetch, calls } = fakeFetch({ "https://x/s": body });
    const cache = new BlobCache({ dir, fetch });
    await Promise.all([cache.ensure(sha, "https://x/s"), cache.ensure(sha, "https://x/s")]);
    expect(calls).toHaveLength(1);
  });

  it("rejects a body whose sha256 doesn't match, and caches nothing", async () => {
    const sha = sha256Hex("expected");
    const { fetch } = fakeFetch({ "https://x/evil": "tampered" });
    const cache = new BlobCache({ dir, fetch });
    await expect(cache.ensure(sha, "https://x/evil")).rejects.toBeInstanceOf(BlobFetchError);
    expect(await cache.has(sha)).toBe(false);
  });

  it("rejects a size mismatch against the manifest", async () => {
    const body = "abc";
    const { fetch } = fakeFetch({ "https://x/a": body });
    const cache = new BlobCache({ dir, fetch });
    await expect(cache.ensure(sha256Hex(body), "https://x/a", 4)).rejects.toThrow(/size mismatch/);
  });

  it("surfaces HTTP and network failures as BlobFetchError", async () => {
    const { fetch } = fakeFetch({ "https://x/403": 403 });
    const cache = new BlobCache({ dir, fetch });
    await expect(cache.ensure(sha256Hex("q"), "https://x/403")).rejects.toThrow(/HTTP 403/);
    await expect(cache.ensure(sha256Hex("q"), "https://x/down")).rejects.toBeInstanceOf(BlobFetchError);
  });
});

describe("BlobCache.read / gc", () => {
  it("re-verifies on read and deletes a corrupted copy", async () => {
    const body = "good";
    const sha = sha256Hex(body);
    const { fetch } = fakeFetch({ "https://x/g": body });
    const cache = new BlobCache({ dir, fetch });
    const path = await cache.ensure(sha, "https://x/g");
    expect((await cache.read(sha)).toString()).toBe(body);

    await writeFile(path, "rotted");
    await expect(cache.read(sha)).rejects.toThrow(/corrupt/);
    await expect(stat(path)).rejects.toThrow();
  });

  it("removes every blob not in the keep set", async () => {
    const keepBody = "keep";
    const dropBody = "drop";
    const { fetch } = fakeFetch({ "https://x/k": keepBody, "https://x/d": dropBody });
    const cache = new BlobCache({ dir, fetch });
    await cache.ensure(sha256Hex(keepBody), "https://x/k");
    await cache.ensure(sha256Hex(dropBody), "https://x/d");
    // A stray temp file from an interrupted write is swept too.
    await writeFile(join(dir, sha256Hex(keepBody).slice(0, 2), "junk.tmp-1-abc"), "x");

    const removed = await cache.gc(new Set([sha256Hex(keepBody)]));
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await cache.has(sha256Hex(keepBody))).toBe(true);
    expect(await cache.has(sha256Hex(dropBody))).toBe(false);
  });
});

describe("mapLimit", () => {
  it("runs at most `limit` tasks at once and keeps result order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("rejects with the first error", async () => {
    await expect(
      mapLimit([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("bad");
        return n;
      }),
    ).rejects.toThrow("bad");
  });
});
