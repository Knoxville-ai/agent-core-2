import {
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
} from "jose";

import type { AgentEnv } from "../env.js";

/**
 * Bearer JWT verification for the shim's HTTP surface.
 *
 * Accepts these token shapes:
 *
 * 1. Platform token (`iss: "knoxville-platform"`) minted by the console for a
 *    user turn (`kind: "user"`), a delegated agent-to-agent turn
 *    (`kind: "agent"`) or a platform-originated turn such as a task wake-up
 *    (`kind: "service"`, bound to one conversation). ES256, verified against
 *    the console's public JWKS (PLATFORM_JWKS_URL). `aud` must equal this
 *    agent's UID, so a token minted for agent A can't be replayed against B.
 *    The container holds no signing material for these: a leaked env can't
 *    mint them. A user or agent token minted for a task start or cancel also
 *    carries `task_id` / `task_org_id` / `task_callback_url` and is then good
 *    for that task's routes only (bearer-policy.ts).
 *
 * 2. Legacy forms, accepted only under AGENT_BEARER_POLICY=legacy-org-check
 *    (the default while older consoles are deployed):
 *    - Supabase access token (a human using an older console). Asymmetric
 *      against the project JWKS, or HS256 against SUPABASE_JWT_SECRET while a
 *      legacy deployment still sets it. Audience must be "authenticated". A
 *      real session token is marked `source: "supabase-session"` and is only
 *      honoured for a member of AGENT_ORG (bearer-policy.ts).
 *    - The console's own HS256 user token (Supabase-shaped, without session
 *      claims) and HS256 agent-service (A2A) token, both over the shared
 *      SUPABASE_JWT_SECRET and only while that secret is set.
 *
 * Dispatch peeks at the unverified `iss` / `kind` claims; every verifier
 * re-parses the token with full signature + claim checks.
 */

export const A2A_TOKEN_KIND = "agent";
/** Platform token for a platform-originated turn (e.g. a task wake-up). */
export const SERVICE_TOKEN_KIND = "service";
/** `scope` of a user token the console minted for an operator action on the
 *  agent (model OAuth), after checking the user may manage the agent. */
export const AGENT_CONTROL_SCOPE = "agent-control";
export const PLATFORM_TOKEN_ISSUER = "knoxville-platform";
/** Console route that serves the public keys for platform tokens. */
export const PLATFORM_JWKS_PATH = "/api/agent-auth/jwks";

const ASYMMETRIC_ALGS = new Set([
  "ES256",
  "ES384",
  "ES512",
  "RS256",
  "RS384",
  "RS512",
  "EdDSA",
]);

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(supabaseUrl: string): ReturnType<typeof createRemoteJWKSet> {
  const trimmed = supabaseUrl.replace(/\/+$/, "");
  let fn = jwksCache.get(trimmed);
  if (!fn) {
    fn = createRemoteJWKSet(
      new URL(`${trimmed}/auth/v1/.well-known/jwks.json`),
    );
    jwksCache.set(trimmed, fn);
  }
  return fn;
}

type KeySet = ReturnType<typeof createRemoteJWKSet>;

const platformJwksCache = new Map<string, KeySet>();

/**
 * Where the console publishes its platform-token public keys: PLATFORM_JWKS_URL
 * when set, else the same origin as PLATFORM_MCP_URL. Null when neither is set
 * (a vessel with no console attachment can't accept platform tokens).
 */
export function platformJwksUrl(
  env: Pick<AgentEnv, "PLATFORM_JWKS_URL" | "PLATFORM_MCP_URL">,
): string | null {
  if (env.PLATFORM_JWKS_URL) return env.PLATFORM_JWKS_URL;
  if (!env.PLATFORM_MCP_URL) return null;
  return new URL(PLATFORM_JWKS_PATH, env.PLATFORM_MCP_URL).toString();
}

function getPlatformJwks(url: string): KeySet {
  let fn = platformJwksCache.get(url);
  if (!fn) {
    fn = createRemoteJWKSet(new URL(url));
    platformJwksCache.set(url, fn);
  }
  return fn;
}

export interface VerifyDeps {
  /** Override the platform key set (tests). */
  platformJwks?: Parameters<typeof jwtVerify>[1];
}

/**
 * Where a principal's token came from:
 *  - `platform`: a console-minted ES256 platform token.
 *  - `legacy-console`: an HS256 token the console signed with the shared
 *    SUPABASE_JWT_SECRET (pre-platform consoles).
 *  - `supabase-session`: a user's own Supabase session token, which
 *    pre-platform consoles forwarded as-is. Only honoured for members of
 *    AGENT_ORG.
 */
export type BearerSource = "platform" | "legacy-console" | "supabase-session";

/** The task a token was minted for (task start / cancel). */
export interface TaskBinding {
  taskId: string;
  /** The org that owns the task; must be this agent's org. */
  orgId: string;
  /** The callback URL the console expects progress and results on. */
  callbackUrl: string;
}

export type Principal =
  | {
      kind: "user";
      userId: string;
      email: string | null;
      role: string | null;
      source: BearerSource;
      /** What the console minted the token for beyond a chat turn, e.g.
       *  AGENT_CONTROL_SCOPE for the model-OAuth routes. */
      scope?: string;
      task?: TaskBinding;
    }
  | {
      kind: "agent";
      agentUid: string;
      targetUid: string;
      orgId: string;
      source: BearerSource;
      task?: TaskBinding;
    }
  | {
      /** A platform-originated turn (no person or agent behind it), bound to
       *  one conversation. Its message is stored as untrusted platform data. */
      kind: "service";
      subject: string;
      conversationId: string;
      origin: string;
      source: "platform";
    };

/** Origins a platform service token may name (`origin` claim). */
const SERVICE_ORIGIN = /^[a-z][a-z0-9-]{0,39}$/;

export function isPlatformOnly(env: Pick<AgentEnv, "AGENT_BEARER_POLICY">): boolean {
  return env.AGENT_BEARER_POLICY === "platform-only";
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export async function verifyBearer(
  authorization: string | undefined,
  env: AgentEnv,
  deps: VerifyDeps = {},
): Promise<Principal> {
  if (!authorization || !authorization.startsWith("Bearer ")) {
    throw new HttpError(401, "missing bearer");
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) throw new HttpError(401, "empty bearer");

  // Peek `iss` / `kind` to pick the verifier. Never trust this peek for
  // security — every verifier re-parses the token with full signature + claim
  // checks.
  let unverifiedKind: string | undefined;
  let unverifiedIss: string | undefined;
  try {
    const claims = decodeJwt(token);
    unverifiedKind =
      typeof claims.kind === "string" ? claims.kind : undefined;
    unverifiedIss = typeof claims.iss === "string" ? claims.iss : undefined;
  } catch {
    throw new HttpError(401, "malformed bearer token");
  }

  if (unverifiedIss === PLATFORM_TOKEN_ISSUER) {
    return verifyPlatformJwt(token, env, deps);
  }
  if (isPlatformOnly(env)) {
    throw new HttpError(401, "only platform tokens are accepted");
  }
  if (unverifiedKind === A2A_TOKEN_KIND) {
    return verifyAgentServiceJwt(token, env);
  }
  return verifySupabaseJwt(token, env);
}

async function verifyPlatformJwt(
  token: string,
  env: AgentEnv,
  deps: VerifyDeps,
): Promise<Principal> {
  let keys = deps.platformJwks;
  if (!keys) {
    const url = platformJwksUrl(env);
    if (!url) {
      throw new HttpError(503, "platform token but no PLATFORM_JWKS_URL set");
    }
    keys = getPlatformJwks(url);
  }
  try {
    const { payload } = await jwtVerify(token, keys as KeySet, {
      algorithms: ["ES256"],
      issuer: PLATFORM_TOKEN_ISSUER,
      audience: env.AGENT_UID,
    });
    const sub = typeof payload.sub === "string" ? payload.sub : "";
    if (!sub) throw new HttpError(401, "token has no subject");
    if (payload.kind === SERVICE_TOKEN_KIND) {
      const conversationId =
        typeof payload.conversation_id === "string" ? payload.conversation_id : "";
      if (!conversationId) throw new HttpError(401, "service token missing conversation_id");
      const origin = typeof payload.origin === "string" ? payload.origin : "";
      if (!SERVICE_ORIGIN.test(origin)) throw new HttpError(401, "service token missing origin");
      return { kind: "service", subject: sub, conversationId, origin, source: "platform" };
    }
    const task = readTaskBinding(payload);
    if (payload.kind === A2A_TOKEN_KIND) {
      const orgId = typeof payload.org_id === "string" ? payload.org_id : "";
      if (!orgId) throw new HttpError(401, "agent token missing org_id");
      return {
        kind: "agent",
        agentUid: sub,
        targetUid: env.AGENT_UID,
        orgId,
        source: "platform",
        ...(task ? { task } : {}),
      };
    }
    if (payload.kind !== "user") {
      throw new HttpError(401, `unexpected platform token kind: ${String(payload.kind)}`);
    }
    return {
      kind: "user",
      userId: sub,
      email: typeof payload.email === "string" ? payload.email : null,
      role: "authenticated",
      source: "platform",
      ...(typeof payload.scope === "string" && payload.scope ? { scope: payload.scope } : {}),
      ...(task ? { task } : {}),
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      401,
      `bearer verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function verifySupabaseJwt(
  token: string,
  env: AgentEnv,
): Promise<Principal> {
  const alg = readAlg(token);
  if (alg === "HS256" && !env.SUPABASE_JWT_SECRET) {
    throw new HttpError(401, "HS256 bearer not accepted (no shared secret set)");
  }
  try {
    const { payload } =
      alg === "HS256"
        ? await jwtVerify(
            token,
            new TextEncoder().encode(env.SUPABASE_JWT_SECRET),
            { algorithms: ["HS256"], audience: "authenticated" },
          )
        : ASYMMETRIC_ALGS.has(alg)
          ? await jwtVerify(token, getJwks(env.SUPABASE_URL), {
              algorithms: [alg],
              audience: "authenticated",
            })
          : (() => {
              throw new HttpError(401, `unsupported jwt alg: ${alg}`);
            })();
    const sub = typeof payload.sub === "string" ? payload.sub : "";
    if (!sub) throw new HttpError(401, "token has no subject");
    // Supabase auth issues sessions with session claims, and asymmetric
    // tokens only ever come from it. The console's own legacy HS256 user token
    // is Supabase-shaped but carries neither, and only a holder of the shared
    // secret can sign one.
    const isSession =
      alg !== "HS256" || payload.session_id !== undefined || payload.amr !== undefined;
    const task = isSession ? null : readTaskBinding(payload);
    return {
      kind: "user",
      userId: sub,
      email: typeof payload.email === "string" ? payload.email : null,
      role: typeof payload.role === "string" ? payload.role : null,
      source: isSession ? "supabase-session" : "legacy-console",
      ...(task ? { task } : {}),
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      401,
      `bearer verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function verifyAgentServiceJwt(
  token: string,
  env: AgentEnv,
): Promise<Principal> {
  if (!env.SUPABASE_JWT_SECRET) {
    throw new HttpError(401, "agent-service token not accepted (no shared secret set)");
  }
  const alg = readAlg(token);
  if (alg !== "HS256") {
    throw new HttpError(401, `agent-service token must be HS256, got ${alg}`);
  }
  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(env.SUPABASE_JWT_SECRET),
      { algorithms: ["HS256"], audience: env.AGENT_UID },
    );
    if (payload.kind !== A2A_TOKEN_KIND) {
      throw new HttpError(
        401,
        `expected kind=${A2A_TOKEN_KIND}, got ${String(payload.kind)}`,
      );
    }
    const sub = typeof payload.sub === "string" ? payload.sub : "";
    if (!sub) throw new HttpError(401, "agent token has no subject");
    const orgId = typeof payload.org_id === "string" ? payload.org_id : "";
    if (!orgId) throw new HttpError(401, "agent token missing org_id");
    const task = readTaskBinding(payload);
    return {
      kind: "agent",
      agentUid: sub,
      targetUid: env.AGENT_UID,
      orgId,
      source: "legacy-console",
      ...(task ? { task } : {}),
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      401,
      `bearer verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The task a user/agent token was minted for, when it names one. A malformed
 * binding fails the token rather than reading as "not bound".
 */
function readTaskBinding(payload: Record<string, unknown>): TaskBinding | null {
  if (payload.task_id === undefined) return null;
  const taskId = typeof payload.task_id === "string" ? payload.task_id.trim() : "";
  if (!taskId) throw new HttpError(401, "malformed task binding");
  return {
    taskId,
    orgId: typeof payload.task_org_id === "string" ? payload.task_org_id : "",
    callbackUrl:
      typeof payload.task_callback_url === "string" ? payload.task_callback_url : "",
  };
}

function readAlg(token: string): string {
  try {
    const header = decodeProtectedHeader(token);
    return typeof header.alg === "string" ? header.alg : "";
  } catch {
    throw new HttpError(401, "malformed bearer token");
  }
}
