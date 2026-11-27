import { describe, expect, it } from "vitest";

import {
  nodeOptionsWithPreload,
  preloadUrl,
  stripPreloadFromNodeOptions,
} from "./preload-options.js";

describe("gateway preload NODE_OPTIONS", () => {
  const url = "file:///app/dist/openclaw/knox-gateway-preload.js";

  it("points at the compiled preload next to this module", () => {
    expect(preloadUrl()).toMatch(/\/knox-gateway-preload\.js$/);
  });

  it("adds the preload, keeping an operator's options", () => {
    expect(nodeOptionsWithPreload(undefined, url)).toBe(`--import=${url}`);
    expect(nodeOptionsWithPreload(" --max-old-space-size=2048 ", url)).toBe(
      `--max-old-space-size=2048 --import=${url}`,
    );
  });

  it("round-trips: the preload removes exactly what was added", () => {
    expect(stripPreloadFromNodeOptions(nodeOptionsWithPreload(undefined, url))).toBeUndefined();
    expect(
      stripPreloadFromNodeOptions(nodeOptionsWithPreload("--max-old-space-size=2048", url)),
    ).toBe("--max-old-space-size=2048");
    expect(stripPreloadFromNodeOptions("--import=file:///other.js")).toBe(
      "--import=file:///other.js",
    );
  });
});
