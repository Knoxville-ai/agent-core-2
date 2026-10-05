// Pure-ish logic for publish_artifact's `file_path` (console migration 0138),
// split out from index.js so it can be unit-tested without the OpenClaw SDK.
//
// The platform's publish_artifact tool takes the page's HTML. An agent building
// a page usually writes it to a file in its workspace first — and revises that
// file — so re-sending the whole document as a tool argument on every revision
// is slow and burns output tokens. publish_artifact therefore also accepts
// `file_path`: the runtime (this module) reads the file from the workspace and
// sends its contents as `html`, the same way Claude's own Artifact tool takes a
// path. The console never sees the path; the model never re-types the page.

import { realpath, stat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

/** The platform's artifact publisher. Same namespacing rules as outcome.js. */
const PUBLISH_ARTIFACT_SUFFIX = /(^|[.:/]|__)publish_artifact$/;

/** Mirrors ARTIFACT_LIMITS.maxHtmlBytes in the console (src/lib/artifacts/policy.ts). */
export const MAX_ARTIFACT_BYTES = 3_500_000;

/** True when `toolName` is publish_artifact (bare or prefixed). */
export function isPublishArtifactTool(toolName) {
  return typeof toolName === "string" && PUBLISH_ARTIFACT_SUFFIX.test(toolName);
}

/** The agent's workspace — where its files tools read and write. */
export function workspaceDir(env = process.env) {
  const state = env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
  return join(state, "workspace");
}

/**
 * The absolute path `filePath` names inside `root`, or null when it points
 * outside it. Relative paths are taken relative to the workspace; absolute ones
 * must already be inside it. Lexical only — readArtifactFile re-checks after
 * resolving symlinks.
 */
export function resolveInside(filePath, root) {
  if (typeof filePath !== "string" || filePath.trim() === "") return null;
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

/**
 * Read the file a publish_artifact call names. Returns `{ html }` or
 * `{ error }` with a sentence the model can act on.
 */
export async function readArtifactFile(filePath, root, fs = { realpath, stat, readFile }) {
  const lexical = resolveInside(filePath, root);
  if (!lexical) {
    return { error: `file_path must be a file inside your workspace (${root}); got ${filePath}.` };
  }
  let real;
  let realRoot;
  try {
    [real, realRoot] = await Promise.all([fs.realpath(lexical), fs.realpath(root)]);
  } catch {
    return { error: `No file at ${filePath} in your workspace. Write the page there first.` };
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    return { error: `file_path must be a file inside your workspace; ${filePath} links outside it.` };
  }
  let info;
  try {
    info = await fs.stat(real);
  } catch {
    return { error: `No file at ${filePath} in your workspace. Write the page there first.` };
  }
  if (!info.isFile()) return { error: `${filePath} is not a file.` };
  if (info.size > MAX_ARTIFACT_BYTES) {
    const mb = (n) => (n / 1_000_000).toFixed(1);
    return {
      error:
        `${filePath} is ${mb(info.size)} MB; the limit is ${mb(MAX_ARTIFACT_BYTES)} MB. ` +
        "Load libraries from an allowed CDN instead of inlining them, and reference images by URL.",
    };
  }
  const html = await fs.readFile(real, "utf8");
  return { html };
}

/**
 * The publish_artifact params with `file_path` swapped for the file's contents,
 * or `null` when there is nothing to swap (no file_path, or `html` already
 * given — explicit html wins and the path is just dropped). On a read error the
 * path stays and `error` says why, so the platform can return it to the model.
 * The input object is never mutated.
 */
export async function inlineArtifactFile(params, root, fs) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  if (typeof params.file_path !== "string") return null;
  const { file_path: filePath, ...rest } = params;
  if (typeof params.html === "string" && params.html.length > 0) return { params: rest };
  const read = await readArtifactFile(filePath, root, fs);
  if ("error" in read) return { params: null, error: read.error };
  return { params: { ...rest, html: read.html } };
}
