import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";

/**
 * Thin wrapper around the `agent-data` bucket used by the console contract
 * (see knoxville-ai-console/CONTRACT.md). Service-role only.
 *
 * Path layout:
 *   orgs/{org}/agents/{uid}/manifest.json
 *   orgs/{org}/agents/{uid}/memory/{system_prompt,identity,boot,playbook}.md
 *   orgs/{org}/agents/{uid}/config/{policies,policy_schema}.json
 *   orgs/{org}/agents/{uid}/state/state.json
 *   orgs/{org}/agents/{uid}/logs/actions-YYYY-MM-DD.jsonl
 */

const BUCKET = "agent-data";

export class AgentStorage {
  private readonly client: SupabaseClient;
  private readonly prefix: string;

  constructor(env: AgentEnv) {
    this.client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    this.prefix = `orgs/${env.AGENT_ORG}/agents/${env.AGENT_UID}`;
  }

  private key(rel: string): string {
    return `${this.prefix}/${rel.replace(/^\/+/, "")}`;
  }

  async downloadText(rel: string): Promise<string | null> {
    const key = this.key(rel);
    const { data, error } = await this.client.storage.from(BUCKET).download(key);
    if (error) {
      // Storage returns a 400-family error for missing objects; surface only
      // unexpected failures.
      if (error.message?.toLowerCase().includes("not found")) {
        return null;
      }
      log.warn("storage.download failed", { key, error: error.message });
      return null;
    }
    return await data.text();
  }

  async downloadJSON<T = unknown>(rel: string): Promise<T | null> {
    const text = await this.downloadText(rel);
    if (text == null) return null;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      log.warn("storage.downloadJSON parse failed", { rel, err: String(err) });
      return null;
    }
  }

  async uploadText(rel: string, body: string, contentType: string): Promise<void> {
    const key = this.key(rel);
    const { error } = await this.client.storage
      .from(BUCKET)
      .upload(key, new Blob([body], { type: contentType }), {
        upsert: true,
        contentType,
      });
    if (error) {
      throw new Error(`storage upload failed (${key}): ${error.message}`);
    }
  }

  async uploadJSON(rel: string, value: unknown): Promise<void> {
    await this.uploadText(rel, JSON.stringify(value, null, 2), "application/json");
  }
}
