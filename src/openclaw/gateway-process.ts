import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";

/**
 * Spawns `openclaw gateway` as a child process. We point openclaw at the
 * exact file the shim just wrote via OPENCLAW_CONFIG_PATH so its config
 * lookup can't desync from ours — relying on $HOME-based resolution
 * broke under Railway env overrides.
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
    const configPath = join(this.env.OPENCLAW_HOME, "openclaw.json");
    log.info("spawning openclaw gateway", {
      port,
      home: this.env.OPENCLAW_HOME,
      configPath,
    });

    const child = spawn("openclaw", ["gateway", "--port", port, "--verbose"], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: this.env.OPENCLAW_HOME,
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
