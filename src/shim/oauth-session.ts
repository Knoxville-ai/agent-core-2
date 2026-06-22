import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { HttpError } from "./auth.js";

/**
 * Drives OpenClaw's interactive OAuth login for OpenAI Codex (ChatGPT
 * OAuth) from the shim, so the console can run the flow remotely.
 *
 * Why a PTY: every `openclaw models auth …` command is an interactive TUI
 * in the pinned CLI (2026.5.20) — they refuse a non-TTY and ignore piped
 * stdin. We allocate a pseudo-terminal with util-linux `script` (added to
 * the image) and feed the program the way a human terminal would. We let
 * OpenClaw own the PKCE exchange + the encrypted token store + refresh —
 * we never reimplement its internals.
 *
 * Flow (matches docs/concepts/oauth.md "remote/headless: paste the
 * redirect URL"):
 *   start():    spawn `login --provider openai-codex --method oauth`,
 *               scrape the `auth.openai.com/oauth/authorize?…` URL, hold
 *               the process at its "Paste the redirect URL" prompt.
 *   complete(): type the operator-pasted callback URL into that prompt;
 *               OpenClaw exchanges + writes its encrypted store.
 *
 * The prompt strings below are tied to OpenClaw's wording — if a major
 * OpenClaw upgrade changes them this breaks loudly (timeout), which is the
 * tradeoff we accepted vs. reproducing OpenClaw's on-disk crypto format.
 */

/* eslint-disable no-control-regex */
// Remove ESC-introduced (CSI/OSC) sequences + non-printable control bytes so
// we can pattern-match the plain text the TUI renders. We never strip
// ordinary characters, so a URL printed on its own line survives intact.
// Patterns are built from \u-escaped strings so the source stays printable.
const OSC_RE = new RegExp("\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\\\)", "g");
const CSI_RE = new RegExp("\\u001B\\[[0-9;?]*[ -/]*[@-~]", "g");
const CHARSET_RE = new RegExp("\\u001B[()#][0-9A-Za-z]", "g");
const TWO_CHAR_RE = new RegExp("\\u001B[@-Z\\\\\\]^_]", "g");
const CTRL_RE = new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F]", "g");
function stripAnsi(s: string): string {
  return s
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .replace(CHARSET_RE, "")
    .replace(TWO_CHAR_RE, "")
    .replace(CTRL_RE, "");
}
/* eslint-enable no-control-regex */

const AUTHORIZE_URL_RE =
  /https?:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s"'`]+/i;
const PASTE_PROMPT_RE = /paste the (redirect url|authorization code)/i;
const SUCCESS_RE =
  /(logged in|authenticated|auth profile|signed in|success|saved|complete)/i;
const FAILURE_RE = /(error|failed|invalid|denied|expired|mismatch)/i;

// Keep this comfortably under Railway's ~60s edge timeout so the shim itself
// answers first with a useful error instead of the edge returning a bare 504.
const START_TIMEOUT_MS = 45_000;
const COMPLETE_TIMEOUT_MS = 45_000;
const SESSION_TTL_MS = 10 * 60_000;

interface Session {
  provider: string;
  child: ChildProcess;
  /** ANSI-stripped cumulative output. */
  text: string;
  url: string | null;
  sawPastePrompt: boolean;
  createdAt: number;
  /** Notified on every new output chunk + on exit. */
  onChunk: Array<() => void>;
}

export class OAuthSessionManager {
  private session: Session | null = null;

  constructor(private readonly env: AgentEnv) {}

  /** Begin the OAuth flow; resolves with the provider authorize URL. */
  async start(provider: string): Promise<string> {
    this.cancel("superseded by a new start");

    const stateDir = this.env.OPENCLAW_STATE_DIR;
    const userHome = dirname(stateDir);
    const configPath = join(stateDir, "openclaw.json");
    // Widen the PTY before launching OpenClaw: a default 80-column terminal
    // hard-wraps the ~400-char authorize URL (and the prompt) across lines,
    // which breaks our contiguous URL/prompt matching. `stty` runs inside the
    // PTY that `script` allocates, so OpenClaw inherits the wide width.
    const cmd = `stty cols 1024 rows 50; openclaw models auth login --provider ${provider} --method oauth`;

    // `script -qfec "<cmd>" /dev/null`: -q quiet, -f flush each write,
    // -e return child exit code, -c run the command. /dev/null discards the
    // typescript log; we read the child's PTY output from script's stdout.
    const child = spawn("script", ["-qfec", cmd, "/dev/null"], {
      env: {
        ...process.env,
        HOME: userHome,
        OPENCLAW_HOME: userHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        // Force OpenClaw's remote/headless OAuth branch (isRemoteEnvironment()
        // checks this): it prints the authorize URL + prompts for the pasted
        // redirect URL, instead of binding a local 127.0.0.1:1455 callback
        // server. In-container that bind SUCCEEDS, so without this OpenClaw
        // would sit forever waiting for a browser callback it can't receive.
        REMOTE_CONTAINERS: "true",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const session: Session = {
      provider,
      child,
      text: "",
      url: null,
      sawPastePrompt: false,
      createdAt: Date.now(),
      onChunk: [],
    };
    this.session = session;

    const ingest = (buf: Buffer): void => {
      const clean = stripAnsi(buf.toString("utf8"));
      session.text += clean;
      log.debug("oauth login output", { chunk: clean.slice(0, 400) });
      if (!session.url) {
        const m = session.text.match(AUTHORIZE_URL_RE);
        if (m) session.url = m[0];
      }
      if (PASTE_PROMPT_RE.test(session.text)) session.sawPastePrompt = true;
      for (const cb of session.onChunk.splice(0)) cb();
    };
    child.stdout?.on("data", ingest);
    child.stderr?.on("data", ingest);
    child.on("exit", (code, signal) => {
      log.info("oauth login process exited", { code, signal });
      for (const cb of session.onChunk.splice(0)) cb();
    });
    child.on("error", (err) => {
      log.error("oauth login spawn failed", { err: String(err) });
      for (const cb of session.onChunk.splice(0)) cb();
    });

    try {
      await this.waitFor(
        session,
        () => session.url !== null || session.child.exitCode != null,
        START_TIMEOUT_MS,
        "authorize URL",
      );
    } catch (err) {
      // Surface what OpenClaw actually printed so a timeout is diagnosable
      // from the HTTP response alone (container debug logs aren't always on).
      const tail = session.text.trim().slice(-400) || "<no output>";
      log.warn("oauth start did not yield a URL", {
        err: String(err),
        exitCode: session.child.exitCode,
        output_tail: tail,
      });
      this.cancel("start failed");
      const base = err instanceof HttpError ? err.message : String(err);
      throw new HttpError(
        err instanceof HttpError ? err.status : 502,
        `${base}; OpenClaw output: ${tail}`,
      );
    }

    if (!session.url) {
      this.cancel("no url");
      throw new HttpError(
        502,
        `OpenClaw login exited before emitting an authorize URL: ${session.text
          .trim()
          .slice(-300)}`,
      );
    }
    log.info("oauth authorize url ready", { provider });
    return session.url;
  }

  /** Finish the flow by submitting the pasted callback/redirect URL. */
  async complete(provider: string, callbackUrl: string): Promise<void> {
    const session = this.session;
    if (!session || session.provider !== provider) {
      throw new HttpError(409, "no pending OAuth session for this provider");
    }
    if (session.child.exitCode != null) {
      this.cancel("process already exited");
      throw new HttpError(409, "OAuth session is no longer active");
    }

    // Wait (briefly) for the paste prompt before typing, so we don't write
    // ahead of readline. If it never appears we still try — readline buffers.
    await this.waitFor(
      session,
      () => session.sawPastePrompt,
      10_000,
      "paste prompt",
    ).catch(() => undefined);

    const baselineLen = session.text.length;
    session.child.stdin?.write(`${callbackUrl.trim()}\n`);

    // Resolve when we see success/failure text after our input, or on exit.
    await this.waitFor(
      session,
      () => {
        const tail = session.text.slice(baselineLen);
        return (
          SUCCESS_RE.test(tail) ||
          FAILURE_RE.test(tail) ||
          session.child.exitCode != null
        );
      },
      COMPLETE_TIMEOUT_MS,
      "exchange result",
    );

    const tail = session.text.slice(baselineLen);
    const exitOk =
      session.child.exitCode === 0 || session.child.exitCode == null;
    const failed = FAILURE_RE.test(tail) && !SUCCESS_RE.test(tail);
    this.cancel("completed");

    if (failed || !exitOk) {
      throw new HttpError(
        400,
        `OAuth exchange failed: ${tail.trim().slice(-200) || "unknown error"}`,
      );
    }
  }

  hasPending(provider: string): boolean {
    return (
      this.session?.provider === provider &&
      Date.now() - this.session.createdAt < SESSION_TTL_MS &&
      this.session.child.exitCode == null
    );
  }

  /** Kill any in-flight session. */
  cancel(reason: string): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    try {
      session.child.stdin?.end();
      if (session.child.exitCode == null) session.child.kill("SIGKILL");
    } catch {
      // best effort
    }
    log.debug("oauth session cancelled", { reason });
  }

  private waitFor(
    session: Session,
    predicate: () => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new HttpError(504, `timed out waiting for ${label}`));
      }, timeoutMs);
      const onChunk = (): void => {
        if (predicate()) {
          cleanup();
          resolve();
        } else if (this.session !== session) {
          cleanup();
          reject(new HttpError(409, "OAuth session was replaced"));
        }
      };
      const cleanup = (): void => {
        clearTimeout(timer);
      };
      session.onChunk.push(onChunk);
    });
  }
}
