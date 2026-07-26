/**
 * Bundle types mirrored from knoxville-ai-console's drive-throughs/types.ts.
 * Kept hand-rolled here (rather than imported) so agent-core-2 stays free
 * of a console dependency — the contract is the MCP response shape, not a
 * shared module. Changes to the console-side types that affect the wire
 * format require a matching update here.
 */

export type SkillSource = "clawhub" | "git" | "inline";

export interface SkillRequirement {
  source: SkillSource;
  ref: string;
  version: string;
  integrityHash?: string | null;
}

export type EnvVarScope = "container" | "capability";

export interface EnvVarSpec {
  key: string;
  label: string;
  description?: string;
  required: boolean;
  secret: boolean;
  scope: EnvVarScope;
  /** Set when the console resolved a credential binding for this spec.
   *  The actual value lives in process.env[key] (alias is locked to key
   *  for capability bindings). */
  boundCredentialId?: string | null;
  boundEnvKeyAlias?: string | null;
  /** Best-effort human label for the bound credential — boot logs only. */
  boundCredentialLabel?: string | null;
}

export interface SkillOverride {
  path: string;
  patch: string;
}

export interface BundleCapability {
  id?: string;
  name: string;
  description: string;
  actionType: string;
  mode: "read_only" | "write_capable" | "transactional";
  requiresHumanApproval: boolean;
  requiresUserAuth: boolean;
  examples?: string[];

  skill?: SkillRequirement | null;
  envVarSpecs?: EnvVarSpec[];
  promptFragment?: string | null;
  skillOverrides?: SkillOverride[] | null;
}

export interface BundleAssignment {
  listing: {
    id: string;
    slug: string;
    name: string;
    listingStatus: string;
    availability: string;
  };
  capability: BundleCapability;
}

/**
 * An outbound delegation connection: a same-org agent this agent is allowed to
 * open a conversation with, plus the operator's prompt-style instructions on
 * when/how to use it. Surfaced into the boot prompt's DELEGATION section.
 * Mirrors the console `get_my_bundle.connections` wire shape.
 */
export interface DelegationConnection {
  targetAgentUid: string;
  displayName: string;
  label?: string | null;
  instructions: string;
}

/**
 * A public-safe capability summary on a bound drive-thru — enough for the agent
 * to choose the best fit for a request. No owner-only routing/prompt/skill
 * internals (those never leave the vendor's org).
 */
export interface DriveThroughCapabilitySummary {
  id?: string | null;
  name: string;
  description: string;
  actionType: string;
  examples?: string[];
}

/**
 * A curated, cross-org drive-thru connection (console migration 0044): a
 * vendor's PUBLIC listing an operator explicitly bound this agent to, with the
 * capabilities toggled on. Surfaced into the boot prompt's DELEGATION section so
 * the agent reasons "my connections → their capabilities → best fit" over a
 * trusted set — never blind search. Reached with `start_conversation(slug,
 * capability)` on the knoxville_platform MCP server. Mirrors the console
 * `get_my_bundle.driveThroughConnections` wire shape.
 */
export interface DriveThroughConnection {
  slug: string;
  name: string;
  shortDescription: string;
  label?: string | null;
  instructions: string;
  agentCallPolicy: "open" | "authenticated" | "approved";
  capabilities: DriveThroughCapabilitySummary[];
}

export interface AgentBundle {
  agent: { uid: string; orgId: string };
  assignments: BundleAssignment[];
  connections: DelegationConnection[];
  /** Curated cross-org drive-thru bindings the caller agent may reach (0044).
   *  Optional on the wire — an older console omits it (defaults to none). */
  driveThroughConnections?: DriveThroughConnection[];
  /** Whether this agent may ALSO search + call unbound drive-thrus. Optional;
   *  defaults to false (curated connections only). */
  allowOpenDiscovery?: boolean;
}
