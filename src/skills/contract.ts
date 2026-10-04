/**
 * The skills sync contract shared by the console and this vessel. MIRRORED
 * from knoxville-ai-console `src/lib/skills/contract.ts` — keep the two in
 * step. The parts that MUST stay byte-identical in behavior are the manifest
 * digest (`manifestDigest`) and the path/slug/hash rules (`isSafeSkillPath`,
 * `isValidSkillSlug`, `isSha256`): the vessel re-computes the digest before it
 * installs anything, and a review/approval on the console binds to it. The wire
 * types below are the `get_skill_sync_plan` / `report_skill_sync` broker-tool
 * shapes. Pure — no IO — so it is unit-testable.
 *
 * A skill VERSION is a manifest of files, each stored once under its sha256.
 * The version's identity is `manifestDigest(manifest)`.
 */


import { createHash } from "node:crypto";

export interface ManifestEntry {
  /** Relative POSIX path inside the skill folder, e.g. "scripts/run.py". */
  path: string;
  /** Lowercase hex sha256 of the file's bytes. */
  sha256: string;
  /** Size in bytes. */
  size: number;
  /** Written 0755 when true, 0644 otherwise. */
  executable: boolean;
}

/** Limits shared by every write path (aligned with MCP SEP-2640). */
export const SKILL_LIMITS = {
  maxFiles: 512,
  maxTotalBytes: 16 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxSkillMdBytes: 64 * 1024,
  maxPathLength: 255,
  maxPathDepth: 6,
  maxDescriptionChars: 1024,
} as const;

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Agent Skills spec: 1–64 chars, lowercase letters, digits and single hyphens. */
export const SKILL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSkillSlug(slug: string): boolean {
  return slug.length >= 1 && slug.length <= 64 && SKILL_SLUG_RE.test(slug);
}

/**
 * A path the vessel may write: relative, POSIX separators, every segment made
 * of `[A-Za-z0-9._-]`, never `.` or `..`, at most 6 deep. There is no way to
 * express a symlink, device or absolute path in a manifest, so materializing
 * one can't escape the skill folder.
 */
export function isSafeSkillPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > SKILL_LIMITS.maxPathLength) {
    return false;
  }
  if (path.startsWith("/") || path.includes("\\")) return false;
  const segments = path.split("/");
  if (segments.length > SKILL_LIMITS.maxPathDepth) return false;
  return segments.every((s) => s !== "." && s !== ".." && SEGMENT_RE.test(s));
}

export function isSha256(value: string): boolean {
  return SHA256_RE.test(value);
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Byte-wise path order (paths are ASCII by isSafeSkillPath). */
function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The version identity: sha256 over the manifest in canonical form, one line
 * per file sorted by path, fields joined by NUL:
 *
 *   `${path}\0${sha256}\0${size}\0${executable ? "x" : "-"}`   lines joined by "\n"
 *
 * Any change to a path, a byte, a size or an exec bit is a new digest.
 */
export function manifestDigest(entries: ManifestEntry[]): string {
  const lines = [...entries]
    .sort((a, b) => comparePaths(a.path, b.path))
    .map((e) => `${e.path}\u0000${e.sha256}\u0000${e.size}\u0000${e.executable ? "x" : "-"}`);
  return sha256Hex(lines.join("\n"));
}

export type ManifestProblem =
  | { code: "empty" }
  | { code: "missing_skill_md" }
  | { code: "bad_path"; path: string }
  | { code: "duplicate_path"; path: string }
  | { code: "bad_hash"; path: string }
  | { code: "bad_size"; path: string }
  | { code: "too_many_files"; count: number }
  | { code: "too_large"; bytes: number }
  | { code: "file_too_large"; path: string; bytes: number }
  | { code: "skill_md_too_large"; bytes: number };

/** Every structural problem with a manifest (empty array = valid). */
export function validateManifest(entries: ManifestEntry[]): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  if (entries.length === 0) return [{ code: "empty" }];
  if (entries.length > SKILL_LIMITS.maxFiles) {
    problems.push({ code: "too_many_files", count: entries.length });
  }
  const seen = new Set<string>();
  let total = 0;
  for (const e of entries) {
    if (!isSafeSkillPath(e.path)) {
      problems.push({ code: "bad_path", path: String(e.path) });
      continue;
    }
    if (seen.has(e.path)) problems.push({ code: "duplicate_path", path: e.path });
    seen.add(e.path);
    if (!isSha256(e.sha256)) problems.push({ code: "bad_hash", path: e.path });
    if (!Number.isInteger(e.size) || e.size < 0) {
      problems.push({ code: "bad_size", path: e.path });
      continue;
    }
    if (e.size > SKILL_LIMITS.maxFileBytes) {
      problems.push({ code: "file_too_large", path: e.path, bytes: e.size });
    }
    if (e.path === "SKILL.md" && e.size > SKILL_LIMITS.maxSkillMdBytes) {
      problems.push({ code: "skill_md_too_large", bytes: e.size });
    }
    total += e.size;
  }
  if (!seen.has("SKILL.md")) problems.push({ code: "missing_skill_md" });
  if (total > SKILL_LIMITS.maxTotalBytes) problems.push({ code: "too_large", bytes: total });
  return problems;
}

export function describeManifestProblem(p: ManifestProblem): string {
  switch (p.code) {
    case "empty":
      return "the skill has no files";
    case "missing_skill_md":
      return "SKILL.md must be at the root of the skill";
    case "bad_path":
      return `"${p.path}" is not an allowed path (relative, [A-Za-z0-9._-] segments, no "..", at most ${SKILL_LIMITS.maxPathDepth} deep)`;
    case "duplicate_path":
      return `"${p.path}" appears twice`;
    case "bad_hash":
      return `"${p.path}" has an invalid sha256`;
    case "bad_size":
      return `"${p.path}" has an invalid size`;
    case "too_many_files":
      return `${p.count} files; the limit is ${SKILL_LIMITS.maxFiles}`;
    case "too_large":
      return `${Math.round(p.bytes / 1024)} KB in total; the limit is ${SKILL_LIMITS.maxTotalBytes / (1024 * 1024)} MB`;
    case "file_too_large":
      return `"${p.path}" is ${Math.round(p.bytes / 1024)} KB; the per-file limit is ${SKILL_LIMITS.maxFileBytes / (1024 * 1024)} MB`;
    case "skill_md_too_large":
      return `SKILL.md is ${Math.round(p.bytes / 1024)} KB; the limit is ${SKILL_LIMITS.maxSkillMdBytes / 1024} KB`;
  }
}

/** Storage key of a file body in the skills bucket. */
export function blobKey(sha256: string): string {
  return `blobs/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

// ---------------------------------------------------------------------------
// Wire shapes (broker MCP tools + the vessel's /skills/sync route)
// ---------------------------------------------------------------------------

export interface SyncPlanFile extends ManifestEntry {
  /** Short-lived signed download URL for this file's blob. */
  url: string;
}

export interface SyncPlanSkill {
  slug: string;
  skill_id: string;
  version_id: string;
  version: string;
  content_sha256: string;
  /** "capability" skills are required by a drive-thru capability. */
  managed_by: "operator" | "capability";
  /** Boot fails loud when a required skill is in neither the plan result nor the lock. */
  required: boolean;
  /** `metadata.openclaw.skillKey`, when the skill sets one (the openclaw.json entry key). */
  skill_key: string | null;
  requirements: SkillRequirements;
  /** Present only when the vessel's installed digest for this slug differs. */
  files?: SyncPlanFile[];
}

/** A capability skill the library can't resolve yet (transition only). */
export interface SyncPlanLegacySkill {
  slug: string;
  version: string | null;
  required: boolean;
}

export interface SyncPlan {
  generation: number;
  /** True when `if_generation` matched — nothing else is sent. */
  unchanged?: boolean;
  skills?: SyncPlanSkill[];
  /** Capability refs still pointing at ClawHub slugs the library doesn't have. */
  legacy?: SyncPlanLegacySkill[];
}

export interface SyncPlanRequest {
  if_generation?: number;
  /** slug → content_sha256 the vessel has installed right now. */
  installed?: Record<string, string>;
}

export type SyncResultStatus = "installed" | "failed" | "ineligible" | "removed";

export interface SyncResult {
  slug: string;
  skill_id?: string;
  version_id?: string;
  status: SyncResultStatus;
  detail?: {
    error?: string;
    missing_env?: string[];
    missing_bins?: string[];
  };
}

export interface SyncReport {
  generation: number;
  results: SyncResult[];
  /** Folders found under workspace/skills that no plan put there (quarantined). */
  unmanaged?: string[];
  /** sha256 over the sorted `slug@content_sha256` pairs in the vessel's lock. */
  lock_digest?: string;
}

export interface SkillRequirements {
  env: string[];
  bins: string[];
  any_bins: string[];
  uv: string[];
  primary_env: string | null;
  skill_key: string | null;
  os: string[];
}

export const EMPTY_REQUIREMENTS: SkillRequirements = {
  env: [],
  bins: [],
  any_bins: [],
  uv: [],
  primary_env: null,
  skill_key: null,
  os: [],
};
