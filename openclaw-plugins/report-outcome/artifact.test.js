import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MAX_ARTIFACT_BYTES,
  inlineArtifactFile,
  isPublishArtifactTool,
  resolveInside,
  workspaceDir,
} from "./artifact.js";

describe("isPublishArtifactTool", () => {
  it("matches publish_artifact, bare and prefixed", () => {
    expect(isPublishArtifactTool("publish_artifact")).toBe(true);
    expect(isPublishArtifactTool("knoxville_platform__publish_artifact")).toBe(true);
    expect(isPublishArtifactTool("knoxville_platform.publish_artifact")).toBe(true);
  });

  it("does not match its neighbours", () => {
    for (const name of ["get_artifact", "list_my_artifacts", "publish_knowledge", "republish_artifacts", null]) {
      expect(isPublishArtifactTool(name), String(name)).toBe(false);
    }
  });
});

describe("workspaceDir", () => {
  it("is the workspace under the openclaw state dir", () => {
    expect(workspaceDir({ OPENCLAW_STATE_DIR: "/state" })).toBe("/state/workspace");
  });
});

describe("resolveInside", () => {
  it("resolves relative paths against the workspace", () => {
    expect(resolveInside("pages/report.html", "/ws")).toBe("/ws/pages/report.html");
  });

  it("accepts absolute paths inside the workspace", () => {
    expect(resolveInside("/ws/report.html", "/ws")).toBe("/ws/report.html");
  });

  it("refuses anything outside it", () => {
    for (const p of ["../etc/passwd", "/etc/passwd", "/ws", "", "pages/../../x.html", "/wsx/report.html"]) {
      expect(resolveInside(p, "/ws"), p).toBe(null);
    }
  });
});

describe("inlineArtifactFile", () => {
  let root;
  let outside;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "knox-artifact-ws-"));
    outside = await mkdtemp(join(tmpdir(), "knox-artifact-out-"));
    await mkdir(join(root, "pages"));
    await writeFile(join(root, "pages", "report.html"), "<!doctype html><title>Q3</title><p>hi</p>");
    await writeFile(join(outside, "secret.txt"), "nope");
    await symlink(join(outside, "secret.txt"), join(root, "pages", "link.html"));
    await writeFile(join(root, "big.html"), "x".repeat(MAX_ARTIFACT_BYTES + 1));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("swaps file_path for the file's contents and keeps every other param", async () => {
    const params = { title: "Q3", file_path: "pages/report.html", conversation_id: "c1" };
    const out = await inlineArtifactFile(params, root);
    expect(out).toEqual({
      params: { title: "Q3", conversation_id: "c1", html: "<!doctype html><title>Q3</title><p>hi</p>" },
    });
    expect(params.file_path).toBe("pages/report.html"); // not mutated
  });

  it("is a no-op when there is no file_path", async () => {
    expect(await inlineArtifactFile({ html: "<p>x</p>" }, root)).toBe(null);
    expect(await inlineArtifactFile(null, root)).toBe(null);
  });

  it("lets explicit html win and just drops the path", async () => {
    const out = await inlineArtifactFile({ html: "<p>x</p>", file_path: "missing.html" }, root);
    expect(out).toEqual({ params: { html: "<p>x</p>" } });
  });

  it("explains a missing file", async () => {
    const out = await inlineArtifactFile({ file_path: "nope.html" }, root);
    expect(out.params).toBe(null);
    expect(out.error).toMatch(/No file at nope\.html/);
  });

  it("refuses paths outside the workspace, including through a symlink", async () => {
    const escape = await inlineArtifactFile({ file_path: join(outside, "secret.txt") }, root);
    expect(escape.error).toMatch(/inside your workspace/);
    const viaLink = await inlineArtifactFile({ file_path: "pages/link.html" }, root);
    expect(viaLink.error).toMatch(/links outside it/);
  });

  it("refuses a file over the size limit before reading it", async () => {
    const out = await inlineArtifactFile({ file_path: "big.html" }, root);
    expect(out.error).toMatch(/the limit is 3\.5 MB/);
  });

  it("refuses a directory", async () => {
    const out = await inlineArtifactFile({ file_path: "pages" }, root);
    expect(out.error).toMatch(/not a file/);
  });
});
