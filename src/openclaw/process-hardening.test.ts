import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { hardenProcess, type PrctlAddon } from "./process-hardening.js";

function fakeAddon(over: Partial<PrctlAddon> = {}): PrctlAddon {
  let dumpable = 1;
  let nnp = 0;
  return {
    setNonDumpable: () => {
      dumpable = 0;
      return 0;
    },
    getDumpable: () => dumpable,
    setNoNewPrivs: () => {
      nnp = 1;
      return 0;
    },
    getNoNewPrivs: () => nnp,
    ...over,
  };
}

describe("hardenProcess", () => {
  it("marks the process non-dumpable and sets no_new_privs when asked", () => {
    const r = hardenProcess({ platform: "linux", loadAddon: () => fakeAddon(), noNewPrivs: true });
    expect(r).toEqual({ nonDumpable: true, noNewPrivs: true });
  });

  it("leaves no_new_privs alone unless asked", () => {
    let called = false;
    const addon = fakeAddon({
      setNoNewPrivs: () => {
        called = true;
        return 0;
      },
    });
    const r = hardenProcess({ platform: "linux", loadAddon: () => addon });
    expect(r.noNewPrivs).toBe(false);
    expect(called).toBe(false);
  });

  it("reports (never throws) a missing addon", () => {
    const r = hardenProcess({
      platform: "linux",
      loadAddon: () => {
        throw new Error("Cannot find module");
      },
    });
    expect(r.nonDumpable).toBe(false);
    expect(r.error).toMatch(/addon unavailable/);
  });

  it("reports a prctl failure", () => {
    const r = hardenProcess({
      platform: "linux",
      loadAddon: () => fakeAddon({ setNonDumpable: () => 1, getDumpable: () => 1 }),
    });
    expect(r.nonDumpable).toBe(false);
    expect(r.error).toMatch(/PR_SET_DUMPABLE failed/);
  });

  it("is a reported no-op off Linux", () => {
    const r = hardenProcess({ platform: "darwin", loadAddon: () => fakeAddon() });
    expect(r).toMatchObject({ nonDumpable: false, error: expect.stringMatching(/platform/) });
  });
});

// ── The real addon, end to end ───────────────────────────────────────────────
//
// Builds docker/knox-prctl.c the way the Dockerfile does, then checks the
// property the hardening exists for: a same-uid child of a hardened process
// cannot read the parent's environment, while an unhardened parent's is
// readable. Needs a C compiler and the Node-API headers; as root it runs the
// pair under an unprivileged uid with setpriv (root could read either).

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HEADERS = join(dirname(process.execPath), "..", "include", "node");

function has(cmd: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
}

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const canRun =
  process.platform === "linux" &&
  has("gcc") &&
  existsSync(join(HEADERS, "node_api.h")) &&
  (!isRoot || has("setpriv"));

describe.skipIf(!canRun)("knox_prctl addon (built from docker/knox-prctl.c)", () => {
  const dir = mkdtempSync(join(tmpdir(), "knox-prctl-"));
  chmodSync(dir, 0o755);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const addon = join(dir, "knox_prctl.node");
  execFileSync("gcc", [
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-shared",
    "-fPIC",
    `-I${HEADERS}`,
    "-o",
    addon,
    join(REPO, "docker", "knox-prctl.c"),
  ]);
  chmodSync(addon, 0o755);

  // Parent: optionally harden itself, then ask a child (same uid, clean env) to
  // read the parent's /proc/<pid>/environ.
  const script = join(dir, "parent.cjs");
  writeFileSync(
    script,
    `
const { spawnSync } = require("node:child_process");
if (process.argv[2] === "harden") {
  const m = require(${JSON.stringify(addon)});
  if (m.setNonDumpable() !== 0 || m.getDumpable() !== 0) { console.log("HARDEN_FAILED"); process.exit(2); }
}
const r = spawnSync("/bin/sh", ["-c", "cat /proc/" + process.pid + "/environ"], { env: { PATH: "/usr/bin:/bin" } });
process.stdout.write(r.status === 0 && r.stdout.toString().includes("KNOX_TEST_SECRET=s3cret") ? "READABLE" : "UNREADABLE");
`,
  );
  chmodSync(script, 0o644);

  function run(mode: "harden" | "plain"): string {
    const argv = [process.execPath, script, mode];
    const [cmd, ...args] = isRoot
      ? ["setpriv", "--reuid", "65534", "--regid", "65534", "--clear-groups", ...argv]
      : argv;
    return execFileSync(cmd!, args, {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", KNOX_TEST_SECRET: "s3cret" },
    }).toString();
  }

  it("an unhardened process's environment is readable by a same-uid child (the baseline)", () => {
    expect(run("plain")).toBe("READABLE");
  });

  it("a hardened process's environment is not", () => {
    expect(run("harden")).toBe("UNREADABLE");
  });

  it("hardenProcess loads it and both switches take effect", () => {
    // Runs in this test file's own worker process, which exits afterwards.
    expect(hardenProcess({ addonPath: addon, noNewPrivs: true })).toEqual({
      nonDumpable: true,
      noNewPrivs: true,
    });
  });
});
