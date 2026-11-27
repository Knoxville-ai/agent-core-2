import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { agentDataClientFromEnv, type AgentDataClient } from "../agent-data/client.js";

/**
 * Thin wrapper around the `agent-data` bucket used by the console contract
 * (see knoxville-ai-console/CONTRACT.md).
 *
 * Reached through the console's agent data API whenever the console provides
 * it (paths relative to this agent's prefix; the console resolves and checks
 * them), else with the service-role key.
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
  private readonly legacy: SupabaseClient | null;
  private readonly api: AgentDataClient | null;
  private readonly prefix: string;

  // `api` is injectable for tests; production picks from env.
  constructor(env: AgentEnv, api?: AgentDataClient | null) {
    this.api = api === undefined ? agentDataClientFromEnv(env) : api;
    this.legacy = this.api
      ? null
      : createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
    this.prefix = `orgs/${env.AGENT_ORG}/agents/${env.AGENT_UID}`;
  }

  private get client(): SupabaseClient {
    if (!this.legacy) throw new Error("AgentStorage: no database client on the scoped path");
    return this.legacy;
  }

  private static rel(rel: string): string {
    return rel.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  private key(rel: string): string {
    return `${this.prefix}/${AgentStorage.rel(rel)}`;
  }

  /**
   * Download an object by its RAW bucket key, ignoring the per-agent prefix.
   * Used for org-agnostic platform assets (e.g. `platform/constitution.md`)
   * that live at the bucket root, outside `orgs/{org}/agents/{uid}/`. Every
   * caller is service-role. Soft-fails to null so boot never blocks on it.
   */
  async downloadShared(rel: string): Promise<string | null> {
    const key = rel.replace(/^\/+/, "");
    if (this.api) {
      try {
        return await this.api.downloadText("storage.shared.sign", { key });
      } catch (err) {
        log.warn("storage.downloadShared failed", { key, error: String(err) });
        return null;
      }
    }
    const { data, error } = await this.client.storage.from(BUCKET).download(key);
    if (error) {
      if (!error.message?.toLowerCase().includes("not found")) {
        log.warn("storage.downloadShared failed", { key, error: error.message });
      }
      return null;
    }
    return await data.text();
  }

  async downloadText(rel: string): Promise<string | null> {
    if (this.api) {
      try {
        return await this.api.downloadText("storage.sign", { path: AgentStorage.rel(rel) });
      } catch (err) {
        log.warn("storage.download failed", { rel, error: String(err) });
        return null;
      }
    }
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
    if (this.api) {
      try {
        await this.api.call("storage.upload", { path: AgentStorage.rel(rel), body, content_type: contentType });
      } catch (err) {
        throw new Error(`storage upload failed (${rel}): ${String(err)}`);
      }
      return;
    }
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

  /**
   * List the file names directly under a storage prefix (non-recursive).
   * Returns names relative to `rel` (e.g. "foo.md" for `state/notes/foo.md`).
   * Folder entries (id === null) are filtered out. Soft-fails to [] so a
   * transient Storage error never aborts boot.
   */
  async list(rel: string): Promise<string[]> {
    if (this.api) {
      try {
        const { names } = await this.api.call<{ names: string[] }>("storage.list", { path: AgentStorage.rel(rel) });
        return names ?? [];
      } catch (err) {
        log.warn("storage.list failed", { rel, error: String(err) });
        return [];
      }
    }
    const prefix = this.key(rel);
    const { data, error } = await this.client.storage
      .from(BUCKET)
      .list(prefix, { limit: 1000 });
    if (error) {
      log.warn("storage.list failed", { prefix, error: error.message });
      return [];
    }
    return (data ?? []).filter((entry) => entry.id !== null).map((entry) => entry.name);
  }

  /** Delete one object. Fatal on error (callers mirror local deletions). */
  async remove(rel: string): Promise<void> {
    if (this.api) {
      try {
        await this.api.call("storage.remove", { path: AgentStorage.rel(rel) });
      } catch (err) {
        throw new Error(`storage remove failed (${rel}): ${String(err)}`);
      }
      return;
    }
    const key = this.key(rel);
    const { error } = await this.client.storage.from(BUCKET).remove([key]);
    if (error) {
      throw new Error(`storage remove failed (${key}): ${error.message}`);
    }
  }
}
