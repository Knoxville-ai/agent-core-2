/**
 * How ./gateway-process.ts hands ./knox-gateway-preload.ts to the gateway, and
 * how the preload takes itself back out. Kept free of other imports so the
 * preload stays small.
 */

/** Substring of the preload's file name; identifies its `--import` entry. */
export const PRELOAD_MARKER = "knox-gateway-preload";

/** The compiled preload, next to this module in dist/. */
export function preloadUrl(): string {
  return new URL("./knox-gateway-preload.js", import.meta.url).href;
}

/** `existing` NODE_OPTIONS plus an `--import` of the preload. */
export function nodeOptionsWithPreload(existing: string | undefined, url = preloadUrl()): string {
  const flag = /\s/.test(url) ? `--import=${JSON.stringify(url)}` : `--import=${url}`;
  return existing && existing.trim() ? `${existing.trim()} ${flag}` : flag;
}

/** NODE_OPTIONS with every `--import` of the preload removed (undefined when
 *  nothing else is left). */
export function stripPreloadFromNodeOptions(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const kept = value
    .split(/\s+/)
    .filter((part) => part && !(part.startsWith("--import=") && part.includes(PRELOAD_MARKER)));
  return kept.length > 0 ? kept.join(" ") : undefined;
}

export interface PluginTokenIo {
  env: NodeJS.ProcessEnv;
  /** Env var naming the fd (see ./gateway-auth.ts PLUGIN_TOKEN_FD_ENV). */
  fdEnv: string;
  /** Symbol.for() key of the slot on `target`. */
  slot: string;
  target: object;
  read: (fd: number) => string;
  close: (fd: number) => void;
}

/**
 * Receive the plugin loopback token the shim writes to an inherited pipe:
 * read it, close the fd (so nothing the gateway starts inherits it), drop the
 * fd variable from the environment, and keep the token in a non-enumerable,
 * read-only symbol slot on `target` (`process`). Returns whether a token was
 * stored. Never throws.
 */
export function receivePluginToken(io: PluginTokenIo): boolean {
  const raw = io.env[io.fdEnv];
  delete io.env[io.fdEnv];
  if (!raw) return false;
  const fd = Number(raw);
  if (!Number.isInteger(fd) || fd < 3) return false;
  let token = "";
  try {
    token = io.read(fd).trim();
  } catch {
    token = "";
  }
  try {
    io.close(fd);
  } catch {
    /* already closed */
  }
  if (!token) return false;
  try {
    Object.defineProperty(io.target, Symbol.for(io.slot), {
      value: token,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  } catch {
    return false;
  }
  return true;
}
