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
 * Accepts two token shapes (dispatched on the unverified `kind` claim):
 *
 * 1. Supabase access token (a human using the console). HS256 against
 *    SUPABASE_JWT_SECRET (legacy projects) or asymmetric against the
 *    project JWKS at <SUPABASE_URL>/auth/v1/.well-known/jwks.json
 *    (modern projects). Audience must be "authenticated".
 *
 * 2. Agent-service (A2A) token minted by another agent-core container.
 *    HS256 with the shared SUPABASE_JWT_SECRET and `kind: "agent"`. The
 *    `aud` claim must equal this agent's UID — prevents a token minted
 *    for agent A from being replayed against B.
 *
 * Mirrors app/messaging/jwt_auth.py from the original (Python) agent-core.
 */

export const A2A_TOKEN_KIND = "agent";

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
): Promise<Principal> {
  if (!authorization || !authorization.startsWith("Bearer ")) {
    throw new HttpError(401, "missing bearer");
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) throw new HttpError(401, "empty bearer");

  // Peek `kind` to pick the verifier. Never trust this peek for security —
  // both verifiers re-parse the token with full signature + claim checks.
  let unverifiedKind: string | undefined;
  try {
    const claims = decodeJwt(token);
    unverifiedKind =
      typeof claims.kind === "string" ? claims.kind : undefined;
  } catch {
    throw new HttpError(401, "malformed bearer token");
  }

  if (unverifiedKind === A2A_TOKEN_KIND) {
    return verifyAgentServiceJwt(token, env);
  }
  return verifySupabaseJwt(token, env);
}

async function verifySupabaseJwt(
  token: string,
  env: AgentEnv,
): Promise<Principal> {
  const alg = readAlg(token);
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
    throw new HttpError(503, "agent-service token but no shared secret set");
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
