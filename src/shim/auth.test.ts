import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import type { AgentEnv } from "../env.js";
import {
  HttpError,
  PLATFORM_TOKEN_ISSUER,
  platformJwksUrl,
  verifyBearer,
  type VerifyDeps,
} from "./auth.js";

const AGENT_UID = "0123456789abcdef";
const OTHER_UID = "fedcba9876543210";
const LEGACY_SECRET = "legacy-shared-secret-legacy-shared-secret";

function env(over: Partial<AgentEnv> = {}): AgentEnv {
  return {
    AGENT_UID,
    AGENT_ORG: "acme",
    SUPABASE_URL: "http://supabase.invalid",
    SUPABASE_JWT_SECRET: "",
    ...over,
  } as AgentEnv;
}

let privateKey: CryptoKey;
let deps: VerifyDeps;
let strangerKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey as CryptoKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" };
  deps = { platformJwks: createLocalJWKSet({ keys: [jwk] }) };
  strangerKey = (await generateKeyPair("ES256")).privateKey as CryptoKey;
});

function platformToken(
  claims: Record<string, unknown>,
  opts: { aud?: string; key?: CryptoKey; iss?: string; exp?: string } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(opts.iss ?? PLATFORM_TOKEN_ISSUER)
    .setAudience(opts.aud ?? AGENT_UID)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "2m")
    .sign(opts.key ?? privateKey);
}

function hs256(claims: Record<string, unknown>, aud: string): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(new TextEncoder().encode(LEGACY_SECRET));
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
}

describe("platform tokens", () => {
  it("accepts a user token addressed to this agent", async () => {
    const token = await platformToken({ sub: "user-1", kind: "user", email: "a@b.c" });
    const p = await verifyBearer(`Bearer ${token}`, env(), deps);
    expect(p).toEqual({ kind: "user", userId: "user-1", email: "a@b.c", role: "authenticated" });
  });

  it("accepts an agent token addressed to this agent", async () => {
    const token = await platformToken({ sub: OTHER_UID, kind: "agent", org_id: "acme" });
    const p = await verifyBearer(`Bearer ${token}`, env(), deps);
    expect(p).toEqual({ kind: "agent", agentUid: OTHER_UID, targetUid: AGENT_UID, orgId: "acme" });
  });

  it("rejects a token minted for another agent", async () => {
    const token = await platformToken({ sub: "user-1", kind: "user" }, { aud: OTHER_UID });
    expect(await status(verifyBearer(`Bearer ${token}`, env(), deps))).toBe(401);
  });

  it("rejects a token signed by a key the console doesn't publish", async () => {
    const token = await platformToken({ sub: "user-1", kind: "user" }, { key: strangerKey });
    expect(await status(verifyBearer(`Bearer ${token}`, env(), deps))).toBe(401);
  });

  it("rejects an expired token", async () => {
    const token = await platformToken({ sub: "user-1", kind: "user" }, { exp: "-1m" });
    expect(await status(verifyBearer(`Bearer ${token}`, env(), deps))).toBe(401);
  });

  it("rejects an agent token without org_id and an unknown kind", async () => {
    const noOrg = await platformToken({ sub: OTHER_UID, kind: "agent" });
    const task = await platformToken({ sub: "task-1", kind: "task" });
    expect(await status(verifyBearer(`Bearer ${noOrg}`, env(), deps))).toBe(401);
    expect(await status(verifyBearer(`Bearer ${task}`, env(), deps))).toBe(401);
  });

  it("is unavailable when no JWKS location is configured", async () => {
    const token = await platformToken({ sub: "user-1", kind: "user" });
    expect(await status(verifyBearer(`Bearer ${token}`, env()))).toBe(503);
  });
});

describe("legacy shared-secret tokens", () => {
  it("are rejected once SUPABASE_JWT_SECRET is unset", async () => {
    const user = await hs256({ sub: "user-1", role: "authenticated" }, "authenticated");
    const a2a = await hs256({ sub: OTHER_UID, kind: "agent", org_id: "acme" }, AGENT_UID);
    expect(await status(verifyBearer(`Bearer ${user}`, env(), deps))).toBe(401);
    expect(await status(verifyBearer(`Bearer ${a2a}`, env(), deps))).toBe(401);
  });

  it("still verify while SUPABASE_JWT_SECRET is set (rollout window)", async () => {
    const e = env({ SUPABASE_JWT_SECRET: LEGACY_SECRET });
    const user = await hs256({ sub: "user-1", role: "authenticated" }, "authenticated");
    const a2a = await hs256({ sub: OTHER_UID, kind: "agent", org_id: "acme" }, AGENT_UID);
    expect((await verifyBearer(`Bearer ${user}`, e)).kind).toBe("user");
    expect((await verifyBearer(`Bearer ${a2a}`, e)).kind).toBe("agent");
  });
});

describe("platformJwksUrl", () => {
  it("prefers the explicit URL, else derives from PLATFORM_MCP_URL", () => {
    expect(
      platformJwksUrl({ PLATFORM_JWKS_URL: "https://c.example/keys", PLATFORM_MCP_URL: "https://x/api/mcp" }),
    ).toBe("https://c.example/keys");
    expect(platformJwksUrl({ PLATFORM_MCP_URL: "https://console.example/api/mcp" })).toBe(
      "https://console.example/api/agent-auth/jwks",
    );
    expect(platformJwksUrl({})).toBeNull();
  });
});
