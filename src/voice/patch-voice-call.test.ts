import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error -- plain .mjs build script, no type declarations
import { patchPluginDir, patchSource } from "../../docker/patch-voice-call.mjs";

const pinned = dirname(createRequire(import.meta.url).resolve("@openclaw/voice-call/package.json"));

describe("docker/patch-voice-call.mjs", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("patches the pinned plugin once, and the result still parses", () => {
    dir = mkdtempSync(join(tmpdir(), "vc-patch-"));
    cpSync(join(pinned, "dist"), join(dir, "dist"), { recursive: true });
    const first = patchPluginDir(dir);
    expect(first.changed).toBe(true);
    const src = readFileSync(first.file, "utf8");
    expect(src).toContain('addTranscriptEntry(call, "bot", event.text)');
    expect(patchPluginDir(dir).changed).toBe(false); // idempotent
    execFileSync(process.execPath, ["--check", first.file]); // throws on a syntax error
  });

  it("refuses code it doesn't recognize", () => {
    expect(() => patchSource("nothing to see")).toThrow(/found 0/);
  });
});
