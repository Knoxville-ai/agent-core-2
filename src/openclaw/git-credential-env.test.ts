import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * docker/git-credential-env: the GitHub connector path must keep working now
 * that exec commands no longer carry PLATFORM_MCP_URL / PLATFORM_API_TOKEN in
 * their environment — it reads them from openclaw.json instead.
 */

const HELPER = resolve(dirname(fileURLToPath(import.meta.url)), "../../docker/git-credential-env");
const canRun =
  process.platform !== "win32" && spawnSync("sh", ["-c", "command -v curl"]).status === 0;

interface Seen {
  auth: string | undefined;
  body: string;
  path: string | undefined;
}

describe.skipIf(!canRun)("git-credential-env", () => {
  const dir = mkdtempSync(join(tmpdir(), "git-cred-"));
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body, path: req.url });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("username=x-access-token\npassword=app-token\n");
    });
  });
  let base = "";

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  function runHelper(env: Record<string, string>): Promise<string> {
    return new Promise((resolveRun, reject) => {
      const child = spawn("sh", [HELPER, "get"], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, ...env },
      });
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.on("error", reject);
      child.on("exit", () => resolveRun(out));
      child.stdin.end("protocol=https\nhost=github.com\npath=acme/app.git\n");
    });
  }

  it("uses the platform MCP entry of openclaw.json when the env has no platform token", async () => {
    const cfg = join(dir, "openclaw.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        mcp: {
          servers: {
            knoxville_platform: {
              url: base,
              transport: "streamable-http",
              headers: { Authorization: "Bearer knox_agent_test" },
            },
          },
        },
      }),
    );
    seen.length = 0;
    const out = await runHelper({ OPENCLAW_CONFIG_PATH: cfg });
    expect(out).toBe("username=x-access-token\npassword=app-token\n");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/api/mcp/github/git-credential");
    expect(seen[0]!.auth).toBe("Bearer knox_agent_test");
    expect(seen[0]!.body).toBe("protocol=https\nhost=github.com\npath=acme/app.git\n");
  });

  it("still prefers an explicit env pair", async () => {
    seen.length = 0;
    await runHelper({
      PLATFORM_MCP_URL: base,
      PLATFORM_API_TOKEN: "knox_agent_env",
      OPENCLAW_CONFIG_PATH: join(dir, "missing.json"),
    });
    expect(seen[0]!.auth).toBe("Bearer knox_agent_env");
  });

  it("prints nothing without any source", async () => {
    seen.length = 0;
    expect(await runHelper({ OPENCLAW_CONFIG_PATH: join(dir, "missing.json") })).toBe("");
    expect(seen).toHaveLength(0);
  });

  it("a static KNOX_GITHUB_TOKEN wins without a network call", async () => {
    seen.length = 0;
    expect(await runHelper({ KNOX_GITHUB_TOKEN: "ghp_static" })).toBe(
      "username=x-access-token\npassword=ghp_static\n",
    );
    expect(seen).toHaveLength(0);
  });
});
