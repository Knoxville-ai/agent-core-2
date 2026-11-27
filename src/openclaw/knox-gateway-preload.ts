/**
 * Preloaded into the openclaw gateway process (`NODE_OPTIONS=--import=<this>`,
 * set by ./gateway-process.ts) before openclaw itself loads.
 *
 * 1. Makes the gateway non-dumpable and sets no_new_privs (see
 *    ./process-hardening.ts), so the exec tool's commands — the gateway's own
 *    children, same uid — cannot read the gateway's environment or memory, and
 *    cannot gain privileges through setuid binaries.
 * 2. Receives the plugin loopback token from the pipe the shim passed as fd 3
 *    and keeps it in a process-local slot for the knox plugins (see
 *    ./gateway-auth.ts). It is never in any environment.
 * 3. Removes its own `--import` from NODE_OPTIONS so nothing the gateway
 *    starts inherits the preload.
 *
 * Never throws: a failure is logged and the gateway starts as before.
 */
import { closeSync, readFileSync } from "node:fs";

import { PLUGIN_TOKEN_FD_ENV, PLUGIN_TOKEN_SLOT } from "./gateway-auth.js";
import { hardenProcess } from "./process-hardening.js";
import { receivePluginToken, stripPreloadFromNodeOptions } from "./preload-options.js";

function line(level: "info" | "error", msg: string, extra: Record<string, unknown>): void {
  process.stderr.write(
    JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }) + "\n",
  );
}

let hardening: Record<string, unknown> = {};
try {
  hardening = { ...hardenProcess({ noNewPrivs: true }) };
} catch (err) {
  hardening = { error: `hardening threw: ${String(err)}` };
}

const pluginToken = receivePluginToken({
  env: process.env,
  fdEnv: PLUGIN_TOKEN_FD_ENV,
  slot: PLUGIN_TOKEN_SLOT,
  target: process,
  read: (fd) => readFileSync(fd, "utf8"),
  close: (fd) => closeSync(fd),
});

const rest = stripPreloadFromNodeOptions(process.env.NODE_OPTIONS);
if (rest === undefined) delete process.env.NODE_OPTIONS;
else process.env.NODE_OPTIONS = rest;

line(hardening.error || !pluginToken ? "error" : "info", "gateway process hardening", {
  ...hardening,
  pluginToken,
});
