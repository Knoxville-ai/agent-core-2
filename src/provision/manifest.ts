import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { AgentStorage } from "./supabase-storage.js";

const BOOTSTRAP_VERSION = 1; // Bump when the manifest schema or boot contract changes.

interface Manifest {
  agent_uid: string;
  role: string;
  org_id: string;
  created_at: string;
  last_boot: string;
  bootstrap_version: number;
  vessel: {
    kind: "openclaw";
    image_version: string;
  };
}

/**
 * Writes (or refreshes) the agent's manifest.json in Supabase Storage so the
 * console can see "this agent has booted" and read its current vessel info.
 *
 * Per CONTRACT.md the agent is the writer for manifest.json. We preserve
 * created_at across boots; everything else is overwritten.
 */
export async function refreshManifest(env: AgentEnv): Promise<void> {
  const storage = new AgentStorage(env);
  const now = new Date().toISOString();

  const existing = await storage.downloadJSON<Manifest>("manifest.json");
  const created_at = existing?.created_at ?? now;

  const next: Manifest = {
    agent_uid: env.AGENT_UID,
    role: env.AGENT_ROLE,
    org_id: env.AGENT_ORG,
    created_at,
    last_boot: now,
    bootstrap_version: BOOTSTRAP_VERSION,
    vessel: {
      kind: "openclaw",
      image_version: process.env.npm_package_version ?? "0.0.0-dev",
    },
  };

  await storage.uploadJSON("manifest.json", next);
  log.info("manifest refreshed", { last_boot: now, bootstrap_version: BOOTSTRAP_VERSION });
}
