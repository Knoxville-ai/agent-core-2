import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } from "jose";

import type { AgentEnv } from "../env.js";

/**
 * Verifies a bearer JWT minted by Supabase Auth.
 *
 * Supabase projects sign tokens with either:
 *   - HS256 (legacy projects)  → verify with SUPABASE_JWT_SECRET
 *   - ES256 / RS256 / EdDSA …  → verify against the project JWKS at
 *     <SUPABASE_URL>/auth/v1/.well-known/jwks.json
 *
 * We peek the protected header to dispatch, mirroring the verifier in
 * the original agent-core (app/messaging/jwt_auth.py).
 *
 * The console forwards the caller's `session.access_token` as
 * `Authorization: Bearer …` (see knoxville-ai-console
 * src/lib/messaging-proxy.ts).
 */

const ASYMMETRIC_ALGS = new Set([
  "ES256",
  "ES384",
  "ES512",
  "RS256",
  "RS384",
  "RS512",
  "EdDSA",
]);

// Module-scope cache: one JWKS fetcher per Supabase URL. createRemoteJWKSet
// already handles HTTP caching internally, but caching the function itself
// keeps repeated requests from rebuilding it.
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

export async function verifyConsoleBearer(
  authorization: string | undefined,
  env: AgentEnv,
): Promise<{ sub: string; raw: Record<string, unknown> }> {
  if (!authorization || !authorization.startsWith("Bearer ")) {
    throw new HttpError(401, "missing bearer");
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) throw new HttpError(401, "empty bearer");

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
    return { sub, raw: payload as Record<string, unknown> };
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

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}
