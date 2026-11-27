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
