/**
 * Preloaded into the openclaw gateway process (`NODE_OPTIONS=--import=<this>`,
 * set by ./gateway-process.ts) before openclaw itself loads.
 *
 * It makes the gateway non-dumpable and sets no_new_privs (see
 * ./process-hardening.ts), so the exec tool's commands — the gateway's own
 * children, same uid — cannot read the gateway's environment or memory, and
 * cannot gain privileges through setuid binaries.
 *
 * It then removes its own `--import` from NODE_OPTIONS so nothing the gateway
 * starts inherits the preload (openclaw strips NODE_OPTIONS from exec commands
 * anyway; this also covers its internal node children).
 *
 * Never throws: a hardening failure is logged and the gateway starts as before.
 */
import { hardenProcess } from "./process-hardening.js";
import { stripPreloadFromNodeOptions } from "./preload-options.js";

function line(level: "info" | "error", msg: string, extra: Record<string, unknown>): void {
  process.stderr.write(
    JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }) + "\n",
  );
}

try {
  const result = hardenProcess({ noNewPrivs: true });
  line(result.error ? "error" : "info", "gateway process hardening", { ...result });
} catch (err) {
  line("error", "gateway process hardening threw", { err: String(err) });
}

const rest = stripPreloadFromNodeOptions(process.env.NODE_OPTIONS);
if (rest === undefined) delete process.env.NODE_OPTIONS;
else process.env.NODE_OPTIONS = rest;
