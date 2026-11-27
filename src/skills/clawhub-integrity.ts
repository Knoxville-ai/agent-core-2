import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { log } from "../log.js";
import type { SkillRequirement } from "../bundle/types.js";
import { manifestDigest, type ManifestEntry } from "./contract.js";

/**
 * Content pinning for skills installed from ClawHub (the legacy path).
 *
 * After `openclaw skills install` unpacks a skill, the vessel hashes the
 * installed folder with the same `manifestDigest` the skills library uses for
 * `content_sha256` (one line per file: path, sha256, size, exec bit), leaving
 * out the per-install metadata OpenClaw writes next to the content
 * (`.clawhub/`, `.clawdhub/`, `.openclaw/` at the top level — `origin.json`
 * carries an install timestamp). Then:
 *
 *   1. The requirement carries an expected hash (bundle `integrityHash`, the
 *      sync plan's legacy `integrity_sha256`, or the boot list's
 *      `integrityHash`): the digest must equal it, in every mode.
 *   2. No expected hash, `CLAWHUB_INTEGRITY=require`: refused.
 *   3. No expected hash, default (`pin`): trust on first use. The digest is
 *      recorded per `<slug>@<resolved version>` in
 *      `$OPENCLAW_STATE_DIR/clawhub-pins.json` (on the volume), and a later
 *      install of the same slug and version must produce the same digest.
 *      When no version can be determined the install is allowed and logged.
 *
 * A refused install is removed from `skills/` by the resolver before the error
 * propagates, so the content never becomes loadable.
 */

export type ClawhubIntegrityMode = "pin" | "require";

/** `CLAWHUB_INTEGRITY=require` (or `enforce` / `strict`) refuses ClawHub
 *  installs that arrive without an expected hash; anything else is `pin`. */
export function clawhubIntegrityMode(env: NodeJS.ProcessEnv = process.env): ClawhubIntegrityMode {
  const v = env.CLAWHUB_INTEGRITY?.trim().toLowerCase();
  return v === "require" || v === "enforce" || v === "strict" ? "require" : "pin";
}

export const PIN_FILE = "clawhub-pins.json";

/** Top-level entries OpenClaw writes per install (not skill content). */
const METADATA_DIRS = new Set([".clawhub", ".clawdhub", ".openclaw"]);

/** Bound the walk: a ClawHub skill folder is small. */
const MAX_FILES = 4096;
const MAX_DEPTH = 32;

export class ClawhubIntegrityError extends Error {
  constructor(
    public readonly ref: string,
    public readonly reason: "mismatch" | "pin_mismatch" | "missing_hash" | "bad_hash" | "unreadable",
    detail: string,
  ) {
    super(`clawhub integrity check failed for ${ref}: ${detail}`);
    this.name = "ClawhubIntegrityError";
  }
}

/**
 * Normalize an expected hash: 64 hex chars, optionally prefixed `sha256:` or
 * `sha256-`, any case. Returns null for absent/empty, and throws for a value
 * that is present but not a sha256 (never silently treated as "no hash").
 */
export function normalizeIntegrityHash(ref: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ClawhubIntegrityError(ref, "bad_hash", "integrity hash is not a string");
  }
  const v = value.trim();
  if (v === "") return null;
  const hex = v.replace(/^sha256[:-]/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new ClawhubIntegrityError(ref, "bad_hash", "integrity hash is not a sha256 hex digest");
  }
  return hex;
}

/** `manifestDigest` of an installed skill folder (metadata dirs excluded).
 *  Refuses symlinks and anything that is not a regular file or directory. */
export async function skillFolderDigest(dir: string, ref = dir): Promise<string> {
  const entries: ManifestEntry[] = [];
  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new ClawhubIntegrityError(ref, "unreadable", "skill folder nests too deep");
    const names = (await readdir(abs)).sort();
    for (const name of names) {
      if (depth === 0 && METADATA_DIRS.has(name)) continue;
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = await lstat(childAbs);
      if (st.isSymbolicLink()) {
        throw new ClawhubIntegrityError(ref, "unreadable", `skill folder contains a symlink (${childRel})`);
      }
      if (st.isDirectory()) {
        await walk(childAbs, childRel, depth + 1);
        continue;
      }
      if (!st.isFile()) {
        throw new ClawhubIntegrityError(ref, "unreadable", `skill folder contains a special file (${childRel})`);
      }
      if (entries.length >= MAX_FILES) {
        throw new ClawhubIntegrityError(ref, "unreadable", "skill folder has too many files");
      }
      const bytes = await readFile(childAbs);
      entries.push({
        path: childRel,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        executable: (st.mode & 0o111) !== 0,
      });
    }
  };
  await walk(dir, "", 0);
  if (entries.length === 0) throw new ClawhubIntegrityError(ref, "unreadable", "skill folder is empty");
  return manifestDigest(entries);
}

/** The version OpenClaw actually installed (`.clawhub/origin.json`), if any. */
export async function readInstalledClawhubVersion(dir: string): Promise<string | null> {
  for (const meta of [".clawhub", ".clawdhub"]) {
    try {
      const raw = JSON.parse(await readFile(join(dir, meta, "origin.json"), "utf8")) as unknown;
      const v = (raw as { installedVersion?: unknown } | null)?.installedVersion;
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    } catch {
      // absent or unparseable — try the next
    }
  }
  return null;
}

interface PinFile {
  version: 1;
  pins: Record<string, string>;
}

async function readPins(stateDir: string): Promise<PinFile> {
  try {
    const raw = JSON.parse(await readFile(join(stateDir, PIN_FILE), "utf8")) as Partial<PinFile>;
    if (raw && raw.version === 1 && raw.pins && typeof raw.pins === "object") {
      return { version: 1, pins: { ...raw.pins } };
    }
  } catch {
    // absent → empty
  }
  return { version: 1, pins: {} };
}

async function writePins(stateDir: string, file: PinFile): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, PIN_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export interface IntegrityVerdict {
  digest: string;
  /** expected: matched the requirement's hash · pinned: matched or recorded
   *  the trust-on-first-use pin · unpinned: no version to pin against. */
  basis: "expected" | "pinned" | "unpinned";
  version: string | null;
}

/** Check an installed ClawHub skill folder (see the module comment). Throws
 *  ClawhubIntegrityError when the install must be refused. */
export async function verifyClawhubInstall(opts: {
  req: SkillRequirement;
  dir: string;
  stateDir: string;
  mode?: ClawhubIntegrityMode;
}): Promise<IntegrityVerdict> {
  const { req, dir, stateDir } = opts;
  const mode = opts.mode ?? clawhubIntegrityMode();
  const expected = normalizeIntegrityHash(req.ref, req.integrityHash);
  const digest = await skillFolderDigest(dir, req.ref);
  const version = (await readInstalledClawhubVersion(dir)) ?? (req.version || null);

  if (expected) {
    if (digest !== expected) {
      throw new ClawhubIntegrityError(
        req.ref,
        "mismatch",
        `content digest ${digest.slice(0, 12)}… does not match the expected ${expected.slice(0, 12)}…`,
      );
    }
    if (version) await recordPin(stateDir, `${req.ref}@${version}`, digest);
    return { digest, basis: "expected", version };
  }

  if (mode === "require") {
    throw new ClawhubIntegrityError(req.ref, "missing_hash", "no integrity hash was provided (CLAWHUB_INTEGRITY=require)");
  }

  if (!version) {
    log.warn("clawhub install has no integrity hash and no version to pin", { ref: req.ref, digest });
    return { digest, basis: "unpinned", version: null };
  }
  const key = `${req.ref}@${version}`;
  const pins = await readPins(stateDir);
  const recorded = pins.pins[key];
  if (recorded && recorded !== digest) {
    throw new ClawhubIntegrityError(
      req.ref,
      "pin_mismatch",
      `content of ${key} changed since it was first installed (${recorded.slice(0, 12)}… → ${digest.slice(0, 12)}…)`,
    );
  }
  if (!recorded) {
    pins.pins[key] = digest;
    await writePins(stateDir, pins);
    log.warn("clawhub install has no integrity hash; pinned its content on first use", { ref: key, digest });
  }
  return { digest, basis: "pinned", version };
}

async function recordPin(stateDir: string, key: string, digest: string): Promise<void> {
  const pins = await readPins(stateDir);
  if (pins.pins[key] === digest) return;
  pins.pins[key] = digest;
  await writePins(stateDir, pins);
}
