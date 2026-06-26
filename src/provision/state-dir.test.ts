import { chmodSync, mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertStateDirWritable } from "./state-dir.js";

describe("assertStateDirWritable", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knox-statedir-"));
  });

  afterEach(() => {
    // Restore perms so cleanup can recurse into any read-only dir we made.
    try {
      chmodSync(root, 0o700);
    } catch {
      /* best effort */
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("passes on a writable dir and leaves no probe file behind", () => {
    const dir = join(root, "writable");
    mkdirSync(dir);
    expect(() => assertStateDirWritable(dir)).not.toThrow();
    expect(existsSync(join(dir, ".knox-write-check"))).toBe(false);
  });

  it("creates the dir if missing", () => {
    const dir = join(root, "missing");
    expect(() => assertStateDirWritable(dir)).not.toThrow();
    expect(existsSync(dir)).toBe(true);
  });

  it("throws on a non-writable dir (simulates a root-owned volume mount)", () => {
    const dir = join(root, "readonly");
    mkdirSync(dir, { mode: 0o555 });
    chmodSync(dir, 0o555);
    // Running as root ignores DAC perms, so this guard only holds for the
    // unprivileged agent uid we actually run as in the container.
    if (process.getuid?.() === 0) {
      return;
    }
    expect(() => assertStateDirWritable(dir)).toThrow(/not writable/);
  });
});
