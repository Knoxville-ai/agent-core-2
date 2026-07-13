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

export interface AgentBundle {
  agent: { uid: string; orgId: string };
  assignments: BundleAssignment[];
  connections: DelegationConnection[];
}
