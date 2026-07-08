import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";

/**
 * In-container Ollama lifecycle — the local-model data plane.
 *
 * This is deliberately a NO-OP unless `LLM_PROVIDER=ollama`. The image bakes
 * the `ollama` binary (small), but the multi-GB model weights are NEVER pulled
 * at build time and NEVER pulled for an API / external-endpoint agent. Only an
 * agent actually configured for a local model starts `ollama serve` and pulls
 * its weights — so an OpenAI/Anthropic/Groq agent pays zero disk, RAM, or boot
 * cost for this feature.
 *
 * Boot order (see index.ts): this runs BEFORE the openclaw gateway starts, so
 * by the time openclaw makes its first model call the loopback Ollama server is
 * up and the weights are present. Weights live on the persistence volume
 * (OLLAMA_MODELS under OPENCLAW_STATE_DIR), so the pull happens once and every
 * subsequent boot is offline-safe — we check `/api/tags` first and only pull a
 * model that isn't already on the volume.
 *
 * Resource note: even a "small" 7-8B model needs several GB of RAM and runs at
 * seconds-per-token on a CPU-only Railway box. This makes local models viable
 * where they're cheap-and-slow-is-fine; for latency-sensitive agents, point
 * LLM_BASE_URL at an external OpenAI-compatible endpoint instead.
 */

/** Ollama's loopback port. Matches LOCAL_OLLAMA_BASE_URL in render-workspace. */
const OLLAMA_PORT = 11434;
const OLLAMA_HOST = `127.0.0.1:${OLLAMA_PORT}`;
const OLLAMA_BASE = `http://${OLLAMA_HOST}`;

/** How long to wait for `ollama serve` to answer /api/tags before giving up. */
const SERVE_READY_TIMEOUT_MS = 30_000;
const SERVE_POLL_INTERVAL_MS = 500;

export class OllamaProcess {
  private child: ChildProcess | null = null;

  constructor(
    private readonly env: AgentEnv,
    private readonly modelsDir: string,
  ) {}

  /** Spawn `ollama serve`, wait until it's ready, then ensure the model is
   *  present (pulling it once if the volume doesn't already have it). Fatal on
   *  failure: an ollama agent with no server / no weights can't answer a single
   *  turn, so we surface it rather than boot a broken agent. */
  async startAndPull(): Promise<void> {
    if (this.child) throw new Error("ollama already started");

    log.info("starting in-container ollama", {
      model: this.env.LLM_MODEL,
      modelsDir: this.modelsDir,
      host: OLLAMA_HOST,
    });

    const child = spawn("ollama", ["serve"], {
      env: {
        ...process.env,
        // Bind loopback only — reachable from the openclaw gateway in the same
        // container, never from outside.
        OLLAMA_HOST,
        // Persist weights on the Railway volume so the pull happens once.
        OLLAMA_MODELS: this.modelsDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout?.on("data", (c: Buffer) => process.stdout.write(`[ollama] ${c}`));
    child.stderr?.on("data", (c: Buffer) => process.stderr.write(`[ollama] ${c}`));
    child.on("exit", (code, signal) => {
      // If ollama dies while it's the active model backend, take the container
      // down so Railway restarts us — a dead backend means every turn 502s.
      log.error("ollama serve exited", { code, signal });
      if (this.child) process.exit(code ?? 1);
    });

    await this.waitForReady();
    await this.ensureModel();
    log.info("ollama ready", { model: this.env.LLM_MODEL });
  }

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + SERVE_READY_TIMEOUT_MS;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const res = await fetch(`${OLLAMA_BASE}/api/tags`);
        if (res.ok) return;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) {
        throw new Error(
          `ollama serve did not become ready within ${SERVE_READY_TIMEOUT_MS}ms`,
        );
      }
      await sleep(SERVE_POLL_INTERVAL_MS);
    }
  }

  /** Pull the model unless it's already on the volume (offline-safe reboot). */
  private async ensureModel(): Promise<void> {
    const model = this.env.LLM_MODEL;
    if (await this.modelPresent(model)) {
      log.info("ollama model already present on volume, skipping pull", { model });
      return;
    }
    log.info("pulling ollama model (first boot for this model — may take a while)", {
      model,
    });
    const pull = spawn("ollama", ["pull", model], {
      env: { ...process.env, OLLAMA_HOST, OLLAMA_MODELS: this.modelsDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    pull.stdout?.on("data", (c: Buffer) => process.stdout.write(`[ollama pull] ${c}`));
    pull.stderr?.on("data", (c: Buffer) => process.stderr.write(`[ollama pull] ${c}`));
    const [code] = (await once(pull, "exit")) as [number | null];
    if (code !== 0) {
      throw new Error(`\`ollama pull ${model}\` failed with exit code ${code}`);
    }
  }

  /** True if `model` is already downloaded. Handles ollama's implicit
   *  `:latest` tag so "llama3" matches a stored "llama3:latest". */
  private async modelPresent(model: string): Promise<boolean> {
    try {
      const res = await fetch(`${OLLAMA_BASE}/api/tags`);
      if (!res.ok) return false;
      const body = (await res.json()) as { models?: Array<{ name?: string }> };
      const want = model.includes(":") ? model : `${model}:latest`;
      return (body.models ?? []).some((m) => m.name === want || m.name === model);
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null; // clear first so the exit handler doesn't exit()
    child.removeAllListeners("exit");
    if (child.exitCode == null) {
      child.kill("SIGTERM");
      try {
        await Promise.race([once(child, "exit"), sleep(5000)]);
      } catch {
        // best effort
      }
      if (child.exitCode == null) child.kill("SIGKILL");
    }
  }
}

/**
 * Start in-container Ollama IFF this agent is configured for a local model.
 * Returns null (and does nothing — no serve, no weight pull) for every other
 * provider, which is what keeps API/external agents free of the local-model
 * cost. `stateDir` is OPENCLAW_STATE_DIR; weights land in `<stateDir>/ollama`.
 */
export async function maybeStartOllama(
  env: AgentEnv,
): Promise<OllamaProcess | null> {
  if (env.LLM_PROVIDER.trim().toLowerCase() !== "ollama") return null;
  const proc = new OllamaProcess(env, join(env.OPENCLAW_STATE_DIR, "ollama"));
  await proc.startAndPull();
  return proc;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
