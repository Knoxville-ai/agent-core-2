import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";

/**
 * Spawns `openclaw gateway` as a child process. The gateway reads its
 * config from $OPENCLAW_HOME/openclaw.json (rendered by provision/).
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
    log.info("spawning openclaw gateway", { port, home: this.env.OPENCLAW_HOME });

    const child = spawn("openclaw", ["gateway", "--port", port, "--verbose"], {
      env: {
        ...process.env,
        HOME: this.env.OPENCLAW_HOME.replace(/\/\.openclaw\/?$/, ""),
        OPENCLAW_HOME: this.env.OPENCLAW_HOME,
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
