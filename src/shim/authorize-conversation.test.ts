import { describe, expect, it } from "vitest";

import { authorizeConversation } from "./routes-messages.js";
import { HttpError, type Principal } from "./auth.js";
import type { Conversation, MessagingDB } from "./supabase-db.js";
import type { AgentEnv } from "../env.js";

const ORG = "bacon-company";
const AGENT = "560bd7e31e229d1d";
const env = { AGENT_ORG: ORG, AGENT_UID: AGENT } as unknown as AgentEnv;

function conv(over: Partial<Conversation>): Conversation {
  return {
    id: "conv-1",
    org_id: ORG,
    agent_uid: AGENT,
    user_id: null,
    title: null,
    archived_at: null,
    kind: "user_agent",
    ...over,
  } as Conversation;
}

function db(
  conversation: Conversation | null,
  members: Set<string> = new Set(),
): MessagingDB {
  return {
    async getConversation() {
      return conversation;
    },
    async userInOrg(userId: string) {
      return members.has(userId);
    },
  } as unknown as MessagingDB;
}

const agent: Principal = {
  kind: "agent",
  agentUid: "caller00000000aa",
  targetUid: AGENT,
  orgId: ORG,
};
const anonUser: Principal = {
  kind: "user",
  userId: "conv-1", // the console mints an anonymous token subject = conversation id
  email: null,
  role: null,
};
const realUser: Principal = {
  kind: "user",
  userId: "user-123",
  email: null,
  role: null,
};

describe("authorizeConversation", () => {
  it("allows an agent-to-agent turn on an anonymous conversation it owns (the delegation fix)", async () => {
    const c = conv({ user_id: null, origin: "agent" } as Partial<Conversation>);
    await expect(
      authorizeConversation("conv-1", anonUser, db(c), env),
    ).resolves.toMatchObject({ id: "conv-1" });
  });

  it("allows a same-org agent principal", async () => {
    await expect(
      authorizeConversation("conv-1", agent, db(conv({})), env),
    ).resolves.toMatchObject({ id: "conv-1" });
  });

  it("rejects a cross-org agent principal", async () => {
    await expect(
      authorizeConversation(
        "conv-1",
        { ...agent, orgId: "someone-else" },
        db(conv({})),
        env,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("still rejects a cross-org agent when the conversation has no drive-thru binding (0046)", async () => {
    const c = conv({ drive_through_connection_id: null } as Partial<Conversation>);
    await expect(
      authorizeConversation(
        "conv-1",
        { ...agent, orgId: "someone-else" },
        db(c),
        env,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("allows a cross-org agent for a drive-thru-delegated conversation (0046)", async () => {
    const c = conv({
      drive_through_connection_id: "dt-conn-1",
    } as Partial<Conversation>);
    await expect(
      authorizeConversation(
        "conv-1",
        { ...agent, orgId: "someone-else" },
        db(c),
        env,
      ),
    ).resolves.toMatchObject({ id: "conv-1" });
  });

  it("still requires org membership for a user-owned conversation", async () => {
    const c = conv({ user_id: "user-123" });
    await expect(
      authorizeConversation("conv-1", realUser, db(c), env),
    ).rejects.toMatchObject({ status: 403 });
    // ...and passes once the caller is a member
    await expect(
      authorizeConversation("conv-1", realUser, db(c, new Set(["user-123"])), env),
    ).resolves.toMatchObject({ id: "conv-1" });
  });

  it("404s when the conversation belongs to a different agent", async () => {
    const c = conv({ agent_uid: "someotheragent00" });
    await expect(
      authorizeConversation("conv-1", anonUser, db(c), env),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("HttpError is thrown (not a generic error)", async () => {
    await expect(
      authorizeConversation("missing", anonUser, db(null), env),
    ).rejects.toBeInstanceOf(HttpError);
  });
});
