import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";

/**
 * Spawns `openclaw gateway` as a child process. Two env semantics matter
 * and they collide with the Dockerfile's default:
 *
 *   - OPENCLAW_STATE_DIR / OPENCLAW_CONFIG_PATH point openclaw at the
 *     exact state dir + config file the shim renders. We set both.
 *
 *   - OPENCLAW_HOME, in openclaw's own code (see openclaw.mjs
 *     normalizeLauncherHomeValue), is the *user home* equivalent —
 *     openclaw appends `.openclaw` to it when deriving paths in
 *     subprocesses (clawhub skill installs, etc.). The Dockerfile
 *     historically set OPENCLAW_HOME to the state dir, which makes
 *     subprocesses resolve `.openclaw/.openclaw` and fail with EPERM.
 *
 * We override OPENCLAW_HOME (and HOME for good measure) in the spawn
 * env to the *parent* of our state dir so any subprocess that re-derives
 * a path from $OPENCLAW_HOME/.openclaw lands at the right place.
 *
 * We deliberately do NOT implement crash-restart in-process: Railway already
 * restarts the container on exit, and a gateway crash usually means the
 * config is wrong — restarting in a tight loop just burns CPU. If the
 * gateway exits, we exit too and let Railway handle it.
 */
export class GatewayProcess {
  private child: ChildProcess | null = null;

  constructor(private readonly env: AgentEnv) {}

  async start(): Promise<void> {
    if (this.child) throw new Error("gateway already started");

    const port = String(this.env.OPENCLAW_GATEWAY_PORT);
    const stateDir = this.env.OPENCLAW_STATE_DIR;
    const userHome = dirname(stateDir);
    const configPath = join(stateDir, "openclaw.json");
    log.info("spawning openclaw gateway", {
      port,
      stateDir,
      userHome,
      configPath,
    });

    const child = spawn("openclaw", ["gateway", "--port", port, "--verbose"], {
      env: {
        ...process.env,
        HOME: userHome,
        OPENCLAW_HOME: userHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(`[openclaw] ${chunk.toString("utf8")}`);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[openclaw] ${chunk.toString("utf8")}`);
    });

    child.on("exit", (code, signal) => {
      log.error("openclaw gateway exited", { code, signal });
      // Take the whole container down — Railway will restart us.
      process.exit(code ?? 1);
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.removeAllListeners("exit");
    if (child.exitCode == null) {
      child.kill("SIGTERM");
      try {
        await Promise.race([
          once(child, "exit"),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
      } catch {
        // best effort
      }
      if (child.exitCode == null) child.kill("SIGKILL");
    }
  }
}
