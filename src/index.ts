import { bootstrap } from "./boot/bootstrap.js";
import { loadEnv } from "./env.js";
import { log } from "./log.js";
import { GatewayProcess } from "./openclaw/gateway-process.js";
import { maybeStartOllama } from "./openclaw/ollama-process.js";
import { refreshManifest } from "./provision/manifest.js";
import { restoreOAuthStore } from "./provision/oauth-store.js";
import { assertStateDirWritable } from "./provision/state-dir.js";
import { startShim } from "./shim/server.js";

async function main(): Promise<void> {
  const env = loadEnv();
  log.info("agent-core starting", {
    uid: env.AGENT_UID,
    org: env.AGENT_ORG,
    role: env.AGENT_ROLE,
    model: `${env.LLM_PROVIDER}/${env.LLM_MODEL}`,
    http_port: env.AGENT_HTTP_PORT,
    gateway_port: env.OPENCLAW_GATEWAY_PORT,
  });

  // 0. Fail loud if the persistence volume isn't writable. On Railway,
  //    OPENCLAW_STATE_DIR is a mounted volume that the entrypoint chowns to
  //    the agent uid before dropping privileges; a non-writable mount would
  //    silently lose all session/memory continuity, so we crash instead.
  assertStateDirWritable(env.OPENCLAW_STATE_DIR);

  // 1. Bundle-driven bootstrap: fetch capabilities, install skills, validate
  //    env, restore agent-owned memory (playbook.md + notes/, volume-wins),
  //    assemble SOUL.md (constitution + identity + capabilities + delegation +
  //    memory digest + playbook), and render the openclaw workspace. Throws on
  //    missing required creds or skill version conflicts. The returned `memory`
  //    checkpoint is the one restored during boot — reuse it (do not construct a
  //    second, which would double-restore).
  const { memory } = await bootstrap(env);

  // 2. Refresh the agent's manifest so the console sees the boot.
  //    Don't fail boot if Storage is briefly unavailable — log and move on.
  refreshManifest(env).catch((err) => {
    log.warn("manifest refresh failed (non-fatal)", { err: String(err) });
  });

  // 2b. If this agent uses model OAuth, restore the encrypted auth-profile
  //     store from Storage BEFORE the gateway boots so OpenClaw reads back
  //     the token minted on a prior container. Decryptable only because
  //     OPENCLAW_AUTH_PROFILE_SECRET_KEY is a stable per-agent secret.
  //     Non-fatal: a first-ever boot has nothing stored yet (the operator
  //     completes the OAuth flow afterwards via the console).
  if (env.LLM_AUTH_MODE === "oauth") {
    await restoreOAuthStore(env).catch((err) => {
      log.warn("oauth store restore failed (non-fatal)", { err: String(err) });
    });
  }

  // 2c. If this agent runs a LOCAL model (LLM_PROVIDER=ollama), start the
  //     in-container Ollama server and pull the weights BEFORE the gateway
  //     boots, so openclaw's first model call finds a live backend. No-op for
  //     every other provider — an API/external agent never starts Ollama or
  //     downloads weights. Fatal on failure: a local agent with no backend
  //     can't answer a turn. Weights persist on the volume (see ollama-process).
  const ollama = await maybeStartOllama(env);

  // 3. Spawn openclaw gateway as a child. The shim talks to it over the
  //    OpenAI-compatible HTTP endpoint on the same port (loopback), so no
  //    WebSocket client is needed in this process.
  const proc = new GatewayProcess(env);
  await proc.start();

  // 4. Start the HTTP shim. /readyz won't return 200 until the gateway
  //    finishes its startup sidecars; Railway's healthcheck handles the
  //    wait.
  const shim = await startShim(env, proc, memory);

  // 5. Graceful shutdown.
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    log.info("shutdown requested", { signal });
    try {
      await shim.close();
    } catch (err) {
      log.warn("shim close failed", { err: String(err) });
    }
    // Backstop: flush any agent-owned memory edited in the last turn before the
    // container stops (the per-turn checkpoint is the primary path).
    await memory.flush();
    await proc.stop();
    if (ollama) await ollama.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  // Inline the error name + message into the msg field so it shows up
  // in log viewers that only render `msg` (Railway's tail view, etc.).
  // Stack stays in the extra field for richer log sinks.
  const summary =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : String(err);
  log.error(`fatal — ${summary}`, {
    name: err instanceof Error ? err.name : undefined,
    message: err instanceof Error ? err.message : undefined,
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
