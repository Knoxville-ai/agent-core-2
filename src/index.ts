import { loadEnv } from "./env.js";
import { log } from "./log.js";
import { GatewayClient } from "./openclaw/gateway-client.js";
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

  // 3. Spawn openclaw gateway as a child.
  const proc = new GatewayProcess(env);
  await proc.start();

  // 4. Wait for the gateway to accept WS connections, then connect.
  const client = new GatewayClient(
    `ws://127.0.0.1:${env.OPENCLAW_GATEWAY_PORT}/`,
    env.OPENCLAW_GATEWAY_TOKEN,
  );
  await client.connectWithRetry(30_000);
  log.info("gateway client connected");

  // 5. Start the HTTP shim.
  const shim = await startShim(env, client);

  // 6. Graceful shutdown.
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    log.info("shutdown requested", { signal });
    try {
      await shim.close();
    } catch (err) {
      log.warn("shim close failed", { err: String(err) });
    }
    client.close();
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
