import { log } from "../log.js";
import type { ToolCallResult } from "../bundle/client.js";
import {
  EMPTY_REQUIREMENTS,
  type SkillRequirements,
  type SyncPlan,
  type SyncPlanFile,
  type SyncPlanLegacySkill,
  type SyncPlanRequest,
  type SyncPlanSkill,
  type SyncReport,
} from "./contract.js";

/**
 * The vessel side of the two broker tools SkillSync talks to the platform
 * through. Both ride the existing platform MCP transport with the agent token
 * (BundleClient), like `get_delegated_credentials`; neither is ever advertised
 * to the model.
 *
 *   get_skill_sync_plan  SyncPlanRequest → structuredContent: SyncPlan
 *   report_skill_sync    SyncReport      → (ack)
 *
 * A console that predates the skills library answers `get_skill_sync_plan`
 * with `isError` + "Unknown tool: …"; that is surfaced as `{ kind: "legacy" }`
 * so the caller falls back to the bundle + boot-list path. Anything else that
 * goes wrong (network, 5xx, a malformed plan) throws: a transient failure.
 */

export const PLAN_TOOL = "get_skill_sync_plan";
export const REPORT_TOOL = "report_skill_sync";

export type PlanFetchResult =
  | { kind: "plan"; plan: SyncPlan }
  /** The console doesn't know the tool — use the legacy skills path. */
  | { kind: "legacy"; detail: string };

export interface SkillSyncPlatform {
  getSkillSyncPlan(req: SyncPlanRequest): Promise<PlanFetchResult>;
  /** Best effort: never throws. */
  reportSkillSync(report: SyncReport): Promise<void>;
}

/** The plan came back but isn't a SyncPlan. Treated as transient. */
export class PlanShapeError extends Error {
  constructor(detail: string) {
    super(`get_skill_sync_plan returned an invalid plan: ${detail}`);
    this.name = "PlanShapeError";
  }
}

/** Minimal transport SkillSync needs (BundleClient satisfies it). */
export interface ToolCaller {
  callTool(name: string, args: unknown): Promise<ToolCallResult>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function parseRequirements(v: unknown): SkillRequirements {
  if (!isRecord(v)) return { ...EMPTY_REQUIREMENTS };
  return {
    env: strings(v.env),
    bins: strings(v.bins),
    any_bins: strings(v.any_bins),
    uv: strings(v.uv),
    primary_env: strOrNull(v.primary_env),
    skill_key: strOrNull(v.skill_key),
    os: strings(v.os),
  };
}

/** Normalize a file list loosely; per-entry validity (paths, hashes, sizes) is
 *  checked later against the manifest rules, where a bad entry fails only its
 *  own skill. */
function parseFiles(v: unknown): SyncPlanFile[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new PlanShapeError("files is not an array");
  return v.map((f) => {
    const r = isRecord(f) ? f : {};
    return {
      path: typeof r.path === "string" ? r.path : "",
      sha256: typeof r.sha256 === "string" ? r.sha256 : "",
      size: typeof r.size === "number" ? r.size : -1,
      executable: r.executable === true,
      url: typeof r.url === "string" ? r.url : "",
    };
  });
}

function parseSkill(v: unknown, i: number): SyncPlanSkill {
  if (!isRecord(v)) throw new PlanShapeError(`skills[${i}] is not an object`);
  if (typeof v.slug !== "string" || v.slug === "") throw new PlanShapeError(`skills[${i}].slug missing`);
  if (typeof v.content_sha256 !== "string" || v.content_sha256 === "") {
    throw new PlanShapeError(`skills[${i}].content_sha256 missing`);
  }
  const managed = v.managed_by === "capability" ? "capability" : "operator";
  const skill: SyncPlanSkill = {
    slug: v.slug,
    skill_id: typeof v.skill_id === "string" ? v.skill_id : "",
    version_id: typeof v.version_id === "string" ? v.version_id : "",
    version: typeof v.version === "string" ? v.version : "",
    content_sha256: v.content_sha256,
    managed_by: managed,
    required: v.required === true,
    skill_key: strOrNull(v.skill_key),
    requirements: parseRequirements(v.requirements),
  };
  // Keep a managed_by the contract doesn't enumerate yet (e.g. "agent") as-is.
  if (typeof v.managed_by === "string" && v.managed_by !== managed) {
    (skill as { managed_by: string }).managed_by = v.managed_by;
  }
  const files = parseFiles(v.files);
  if (files) skill.files = files;
  return skill;
}

function parseLegacy(v: unknown, i: number): SyncPlanLegacySkill {
  if (!isRecord(v) || typeof v.slug !== "string" || v.slug === "") {
    throw new PlanShapeError(`legacy[${i}] has no slug`);
  }
  return {
    slug: v.slug,
    version: typeof v.version === "string" && v.version !== "" ? v.version : null,
    required: v.required === true,
  };
}

/** Validate `structuredContent` as a SyncPlan. Throws PlanShapeError. Pure. */
export function parseSyncPlan(structured: unknown): SyncPlan {
  if (!isRecord(structured)) throw new PlanShapeError("no structured content");
  const generation = structured.generation;
  if (typeof generation !== "number" || !Number.isFinite(generation) || generation < 0) {
    throw new PlanShapeError("generation missing");
  }
  const plan: SyncPlan = { generation: Math.floor(generation) };
  if (structured.unchanged === true) {
    plan.unchanged = true;
    return plan;
  }
  if (structured.skills !== undefined) {
    if (!Array.isArray(structured.skills)) throw new PlanShapeError("skills is not an array");
    plan.skills = structured.skills.map(parseSkill);
  } else {
    plan.skills = [];
  }
  if (structured.legacy !== undefined) {
    if (!Array.isArray(structured.legacy)) throw new PlanShapeError("legacy is not an array");
    plan.legacy = structured.legacy.map(parseLegacy);
  }
  return plan;
}

function toolText(result: ToolCallResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

function isUnknownTool(message: string): boolean {
  return /unknown tool/i.test(message);
}

/** SkillSyncPlatform over the platform MCP (BundleClient). */
export class McpSkillSyncPlatform implements SkillSyncPlatform {
  constructor(private readonly client: ToolCaller) {}

  async getSkillSyncPlan(req: SyncPlanRequest): Promise<PlanFetchResult> {
    let result: ToolCallResult;
    try {
      result = await this.client.callTool(PLAN_TOOL, req);
    } catch (err) {
      // Some MCP servers reject an unknown tool at the JSON-RPC layer instead.
      if (isUnknownTool(String(err))) return { kind: "legacy", detail: String(err) };
      throw err;
    }
    if (result.isError) {
      const text = toolText(result) || "tool reported error";
      if (isUnknownTool(text)) return { kind: "legacy", detail: text };
      throw new Error(`${PLAN_TOOL} failed: ${text}`);
    }
    return { kind: "plan", plan: parseSyncPlan(result.structuredContent) };
  }

  async reportSkillSync(report: SyncReport): Promise<void> {
    try {
      const result = await this.client.callTool(REPORT_TOOL, report);
      if (result.isError) {
        log.warn("report_skill_sync rejected (ignored)", { msg: toolText(result).slice(0, 300) });
      }
    } catch (err) {
      log.warn("report_skill_sync failed (ignored)", { err: String(err) });
    }
  }
}
