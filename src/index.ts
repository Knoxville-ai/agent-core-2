import { bootstrap } from "./boot/bootstrap.js";
import { loadEnv } from "./env.js";
import { log } from "./log.js";
import { GatewayProcess } from "./openclaw/gateway-process.js";
import { refreshManifest } from "./provision/manifest.js";
import { restoreOAuthStore } from "./provision/oauth-store.js";
import { startShim } from "./shim/server.js";

async function main(): Promise<void> {
  const env = loadEnv();
  log.info("agent-core starting", {
    uid: env.AGENT_UID,
    org: env.AGENT_ORG,
    role: env.AGENT_ROLE,
    model: `${env.LLM_PROVIDER}/${env.LLM_MODEL}`,
    auth_mode: env.LLM_AUTH_MODE,
    build: process.env.BUILD_REF ?? "dev",
    http_port: env.AGENT_HTTP_PORT,
    gateway_port: env.OPENCLAW_GATEWAY_PORT,
  });

  // 1. Bundle-driven bootstrap: fetch capabilities, install skills,
  //    validate env, assemble SOUL.md, render the openclaw workspace.
  //    Throws on missing required creds or skill version conflicts.
  await bootstrap(env);

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

  // 3. Spawn openclaw gateway as a child. The shim talks to it over the
  //    OpenAI-compatible HTTP endpoint on the same port (loopback), so no
  //    WebSocket client is needed in this process.
  const proc = new GatewayProcess(env);
  await proc.start();

  // 4. Start the HTTP shim. /readyz won't return 200 until the gateway
  //    finishes its startup sidecars; Railway's healthcheck handles the
  //    wait.
  const shim = await startShim(env, proc);

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
