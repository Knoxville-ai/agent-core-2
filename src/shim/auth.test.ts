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
    expect(p).toEqual({
      kind: "user",
      userId: "user-1",
      email: "a@b.c",
      role: "authenticated",
      source: "platform",
    });
  });

  it("accepts an agent token addressed to this agent", async () => {
    const token = await platformToken({ sub: OTHER_UID, kind: "agent", org_id: "acme" });
    const p = await verifyBearer(`Bearer ${token}`, env(), deps);
    expect(p).toEqual({
      kind: "agent",
      agentUid: OTHER_UID,
      targetUid: AGENT_UID,
      orgId: "acme",
      source: "platform",
    });
  });

  it("reads the task binding and agent-control scope", async () => {
    const token = await platformToken({
      sub: "user-1",
      kind: "user",
      scope: "agent-control",
      task_id: "task-1",
      task_org_id: "acme",
      task_callback_url: "https://console.example/api/tasks/task-1",
    });
    const p = await verifyBearer(`Bearer ${token}`, env(), deps);
    expect(p).toMatchObject({
      kind: "user",
      scope: "agent-control",
      task: {
        taskId: "task-1",
        orgId: "acme",
        callbackUrl: "https://console.example/api/tasks/task-1",
      },
    });
  });

  it("rejects a malformed task binding", async () => {
    const token = await platformToken({ sub: "user-1", kind: "user", task_id: 42 });
    expect(await status(verifyBearer(`Bearer ${token}`, env(), deps))).toBe(401);
  });

  it("accepts a service token bound to one conversation", async () => {
    const token = await platformToken({
      sub: "task-1",
      kind: "service",
      conversation_id: "conv-1",
      origin: "task-callback",
    });
    const p = await verifyBearer(`Bearer ${token}`, env(), deps);
    expect(p).toEqual({
      kind: "service",
      subject: "task-1",
      conversationId: "conv-1",
      origin: "task-callback",
      source: "platform",
    });
  });

  it("rejects a service token without a conversation or origin", async () => {
    const noConv = await platformToken({ sub: "t", kind: "service", origin: "task-callback" });
    const noOrigin = await platformToken({ sub: "t", kind: "service", conversation_id: "c" });
    const badOrigin = await platformToken({
      sub: "t",
      kind: "service",
      conversation_id: "c",
      origin: "Task Callback!",
    });
    for (const t of [noConv, noOrigin, badOrigin]) {
      expect(await status(verifyBearer(`Bearer ${t}`, env(), deps))).toBe(401);
    }
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

  it("tell a user's own Supabase session apart from the console's HS256 token", async () => {
    const e = env({ SUPABASE_JWT_SECRET: LEGACY_SECRET });
    const consoleToken = await hs256({ sub: "user-1", role: "authenticated" }, "authenticated");
    const session = await hs256(
      { sub: "user-1", role: "authenticated", session_id: "s-1", amr: [{ method: "password" }] },
      "authenticated",
    );
    expect(await verifyBearer(`Bearer ${consoleToken}`, e)).toMatchObject({
      source: "legacy-console",
    });
    expect(await verifyBearer(`Bearer ${session}`, e)).toMatchObject({
      source: "supabase-session",
    });
  });
});

describe("AGENT_BEARER_POLICY=platform-only", () => {
  const strict = (over: Partial<AgentEnv> = {}) =>
    env({ AGENT_BEARER_POLICY: "platform-only", SUPABASE_JWT_SECRET: LEGACY_SECRET, ...over });

  it("rejects a Supabase user session token", async () => {
    const session = await hs256(
      { sub: "user-1", role: "authenticated", session_id: "s-1" },
      "authenticated",
    );
    expect(await status(verifyBearer(`Bearer ${session}`, strict(), deps))).toBe(401);
    // An asymmetric session is refused before any key lookup.
    const pair = await generateKeyPair("ES256");
    const asym = await new SignJWT({ sub: "user-1", role: "authenticated", session_id: "s-1" })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer("http://supabase.invalid/auth/v1")
      .setAudience("authenticated")
      .setExpirationTime("2m")
      .sign(pair.privateKey);
    expect(await status(verifyBearer(`Bearer ${asym}`, strict(), deps))).toBe(401);
  });

  it("rejects the legacy shared-secret forms even while the secret is set", async () => {
    const user = await hs256({ sub: "user-1", role: "authenticated" }, "authenticated");
    const a2a = await hs256({ sub: OTHER_UID, kind: "agent", org_id: "acme" }, AGENT_UID);
    expect(await status(verifyBearer(`Bearer ${user}`, strict(), deps))).toBe(401);
    expect(await status(verifyBearer(`Bearer ${a2a}`, strict(), deps))).toBe(401);
  });

  it("still accepts platform tokens", async () => {
    const token = await platformToken({ sub: "user-1", kind: "user" });
    expect((await verifyBearer(`Bearer ${token}`, strict(), deps)).kind).toBe("user");
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
