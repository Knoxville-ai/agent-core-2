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
 * Accepts three token shapes:
 *
 * 1. Platform token (`iss: "knoxville-platform"`) minted by the console for a
 *    user turn (`kind: "user"`) or a delegated agent-to-agent turn
 *    (`kind: "agent"`). ES256, verified against the console's public JWKS
 *    (PLATFORM_JWKS_URL). `aud` must equal this agent's UID, so a token minted
 *    for agent A can't be replayed against B. The container holds no signing
 *    material for these: a leaked env can't mint them.
 *
 * 2. Supabase access token (a human using the console). Asymmetric against
 *    the project JWKS at <SUPABASE_URL>/auth/v1/.well-known/jwks.json, or
 *    HS256 against SUPABASE_JWT_SECRET while a legacy deployment still sets
 *    it. Audience must be "authenticated".
 *
 * 3. Legacy agent-service (A2A) token: HS256 with the shared
 *    SUPABASE_JWT_SECRET and `kind: "agent"`. Only accepted while that secret
 *    is set; the console stops pushing it once platform tokens are enabled.
 *
 * Dispatch peeks at the unverified `iss` / `kind` claims; every verifier
 * re-parses the token with full signature + claim checks.
 */

export const A2A_TOKEN_KIND = "agent";
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

export type Principal =
  | { kind: "user"; userId: string; email: string | null; role: string | null }
  | { kind: "agent"; agentUid: string; targetUid: string; orgId: string };

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
    if (payload.kind === A2A_TOKEN_KIND) {
      const orgId = typeof payload.org_id === "string" ? payload.org_id : "";
      if (!orgId) throw new HttpError(401, "agent token missing org_id");
      return { kind: "agent", agentUid: sub, targetUid: env.AGENT_UID, orgId };
    }
    if (payload.kind !== "user") {
      throw new HttpError(401, `unexpected platform token kind: ${String(payload.kind)}`);
    }
    return {
      kind: "user",
      userId: sub,
      email: typeof payload.email === "string" ? payload.email : null,
      role: "authenticated",
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
    return {
      kind: "user",
      userId: sub,
      email: typeof payload.email === "string" ? payload.email : null,
      role: typeof payload.role === "string" ? payload.role : null,
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
    return {
      kind: "agent",
      agentUid: sub,
      targetUid: env.AGENT_UID,
      orgId,
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      401,
      `bearer verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function readAlg(token: string): string {
  try {
    const header = decodeProtectedHeader(token);
    return typeof header.alg === "string" ? header.alg : "";
  } catch {
    throw new HttpError(401, "malformed bearer token");
  }
}
