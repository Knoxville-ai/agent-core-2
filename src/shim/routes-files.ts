import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import type { AgentEnv } from "../env.js";
import { HttpError } from "./auth.js";
import { sendJson } from "./util.js";

// Must match the console's AgentFilesPane preview copy (1 MiB).
const READ_CAP_BYTES = 1024 * 1024;

const APP_ROOT = "/app";

/**
 * Roots the operator (the console Files tab) is allowed to browse.
 *
 * Deliberately NARROW: we expose the image code (`/app`) and the rendered
 * agent workspace (`workspace/` — SOUL.md, AGENTS.md, TOOLS.md, playbook.md,
 * skills/), but NOT the openclaw state dir itself. `openclaw.json` sits in
 * the state dir and holds `models.providers.*.apiKey` (the LLM key) plus the
 * pointer to the encrypted OAuth store — browsing must never surface those.
 */
export function allowedRoots(env: AgentEnv): string[] {
  return [APP_ROOT, join(env.OPENCLAW_STATE_DIR, "workspace")];
}

/**
 * Operator auth for the filesystem-inspection surface. Unlike the rest of
 * the shim (which requires a Supabase/A2A JWT), `/files/*` is authenticated
 * with the shared `OPENCLAW_GATEWAY_TOKEN`. Only the console *server* can
 * read that token (out of Railway's env store) — it never reaches a browser
 * — so it acts as an operator capability. Mirrors the v0.2 `/files/*`
 * contract so the console's files proxy works unchanged.
 */
export function requireGatewayToken(
  authorization: string | undefined,
  env: AgentEnv,
): void {
  if (!authorization || !authorization.startsWith("Bearer ")) {
    throw new HttpError(401, "missing bearer");
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (!token || !safeEqual(token, env.OPENCLAW_GATEWAY_TOKEN)) {
    throw new HttpError(401, "invalid operator token");
  }
}

// Constant-time compare. Hash both inputs first so timingSafeEqual never
// sees a length mismatch (it throws) and the raw length isn't leaked.
function safeEqual(a: string, b: string): boolean {
  const ah = createHash("sha256").update(a).digest();
  const bh = createHash("sha256").update(b).digest();
  return timingSafeEqual(ah, bh);
}

/**
 * Resolve a caller-supplied path to a real path confined to an allowed root.
 * realpath() collapses symlinks so a link inside the workspace can't hop out
 * to, say, the openclaw.json next door. Missing paths surface as 404.
 */
async function resolveWithinRoots(raw: string, env: AgentEnv): Promise<string> {
  const roots = allowedRoots(env);
  const candidate = raw && isAbsolute(raw) ? resolve(raw) : roots[0]!;
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new HttpError(404, "not found");
  }
  const ok = roots.some((r) => real === r || real.startsWith(r + sep));
  if (!ok) throw new HttpError(403, "path outside allowed roots");
  return real;
}

interface FileEntry {
  name: string;
  type: "file" | "dir";
  size: number | null;
  mtime: string;
}

/** GET /files/list?path=... — directory listing rooted in the allowlist. */
export async function handleFilesList(
  url: URL,
  res: ServerResponse,
  env: AgentEnv,
): Promise<void> {
  const dir = await resolveWithinRoots(url.searchParams.get("path") ?? "", env);
  const dirStat = await stat(dir);
  if (!dirStat.isDirectory()) throw new HttpError(400, "not a directory");

  const dirents = await readdir(dir, { withFileTypes: true });
  const entries: FileEntry[] = await Promise.all(
    dirents.map(async (d): Promise<FileEntry> => {
      const full = join(dir, d.name);
      let size: number | null = null;
      let mtime = "";
      try {
        const es = await lstat(full);
        size = es.isFile() ? es.size : null;
        mtime = es.mtime.toISOString();
      } catch {
        // Unreadable entry — still list it by name.
      }
      return { name: d.name, type: d.isDirectory() ? "dir" : "file", size, mtime };
    }),
  );
  entries.sort((a, b) =>
    a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
  );
  sendJson(res, 200, { path: dir, entries });
}

/** GET /files/read?path=... — file contents, capped + binary-aware. */
export async function handleFilesRead(
  url: URL,
  res: ServerResponse,
  env: AgentEnv,
): Promise<void> {
  const raw = url.searchParams.get("path") ?? "";
  if (!raw) throw new HttpError(400, "path required");
  const file = await resolveWithinRoots(raw, env);
  const fileStat = await stat(file);
  if (fileStat.isDirectory()) throw new HttpError(400, "path is a directory");

  const buf = await readFile(file);
  const truncated = buf.length > READ_CAP_BYTES;
  const slice = truncated ? buf.subarray(0, READ_CAP_BYTES) : buf;
  const binary = slice.includes(0);
  sendJson(res, 200, {
    path: file,
    size: fileStat.size,
    encoding: binary ? "base64" : "utf-8",
    truncated,
    content: binary ? slice.toString("base64") : slice.toString("utf8"),
  });
}

/**
 * Legacy `/api/v1/agents/:uid/files/...` surface (conversation attachments,
 * not filesystem inspection). Still unimplemented for vessel agents; the
 * console treats 501 as "not supported on this agent."
 */
export function handleFilesPlaceholder(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 501, {
    ok: false,
    error: "file attachments not implemented in openclaw vessel yet",
  });
}
