import { jwtVerify } from "jose";

import type { AgentEnv } from "../env.js";

/**
 * Verifies a bearer JWT minted by Supabase Auth against the shared
 * SUPABASE_JWT_SECRET. The console forwards the caller's
 * `session.access_token` as `Authorization: Bearer …` (see
 * knoxville-ai-console/src/lib/messaging-proxy.ts:14-18).
 *
 * Returns the claim subject (Supabase user id) on success; throws on
 * invalid / expired / missing tokens.
 */
export async function verifyConsoleBearer(
  authorization: string | undefined,
  env: AgentEnv,
): Promise<{ sub: string; raw: Record<string, unknown> }> {
  if (!authorization || !authorization.startsWith("Bearer ")) {
    throw new HttpError(401, "missing bearer");
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) throw new HttpError(401, "empty bearer");

  const key = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
    });
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

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}
