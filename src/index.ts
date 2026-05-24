import { loadEnv } from "./env.js";
import { log } from "./log.js";
import { GatewayProcess } from "./openclaw/gateway-process.js";
import { refreshManifest } from "./provision/manifest.js";
import { renderWorkspace } from "./provision/render-workspace.js";
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

  // 1. Materialize openclaw workspace + config from Storage / env.
  await renderWorkspace(env);

  // 2. Refresh the agent's manifest so the console sees the boot.
  //    Don't fail boot if Storage is briefly unavailable — log and move on.
  refreshManifest(env).catch((err) => {
    log.warn("manifest refresh failed (non-fatal)", { err: String(err) });
  });

  // 3. Spawn openclaw gateway as a child. The shim talks to it over the
  //    OpenAI-compatible HTTP endpoint on the same port (loopback), so no
  //    WebSocket client is needed in this process.
  const proc = new GatewayProcess(env);
  await proc.start();

  // 4. Start the HTTP shim. /readyz won't return 200 until the gateway
  //    finishes its startup sidecars; Railway's healthcheck handles the
  //    wait.
  const shim = await startShim(env);

  // 5. Graceful shutdown.
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    log.info("shutdown requested", { signal });
    try {
      await shim.close();
    } catch (err) {
      log.warn("shim close failed", { err: String(err) });
    }
    await proc.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("fatal", { err: err instanceof Error ? err.stack ?? err.message : String(err) });
  process.exit(1);
});
