import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildSummaryRequest,
  CallLogTail,
  CallMirror,
  cleanSummary,
  consultSessionKey,
  dropRestatedPrefix,
  formatDuration,
  prettyPhone,
  transcriptTurns,
  VoiceConversationIndex,
  voiceSessionTail,
  type CallMirrorStore,
  type CallRecord,
} from "./call-mirror.js";

const T0 = Date.parse("2026-11-18T21:00:00Z");

function call(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call-1",
    direction: "inbound",
    state: "active",
    from: "+19016512542",
    to: "+18653501221",
    startedAt: T0,
    answeredAt: T0 + 2_000,
    transcript: [],
    ...overrides,
  };
}

function fakeStore(member: { userId: string; name: string | null } | null = null) {
  const calls = {
    conversations: [] as Array<{ userId: string | null; title: string }>,
    messages: [] as Array<Parameters<CallMirrorStore["insertMessage"]>[0]>,
    memories: [] as Array<{ conversationId: string; body: string; tags: string[] }>,
  };
  const store: CallMirrorStore = {
    findMemberByPhone: async () => member,
    createConversation: async (input) => {
      calls.conversations.push(input);
      return `conv-${calls.conversations.length}`;
    },
    insertMessage: async (input) => {
      calls.messages.push(input);
    },
    remember: async (input) => {
      calls.memories.push(input);
    },
  };
  return { store, calls };
}

function mirror(
  store: CallMirrorStore,
  opts: { summary?: string | null; index?: VoiceConversationIndex } = {},
) {
  const requests: Array<Record<string, unknown>> = [];
  const m = new CallMirror({
    store,
    agentUid: "frank",
    scope: "per-phone",
    summarize: async (req) => {
      requests.push(req);
      return opts.summary === undefined ? "Zach asked for the weather. Frank answered." : opts.summary;
    },
    index: opts.index ?? new VoiceConversationIndex(),
    now: () => T0 + 60_000,
  });
  return { m, requests };
}

const TRANSCRIPT = [
  { timestamp: T0 + 3_000, speaker: "bot" as const, text: "Hi, this is Frank.", isFinal: true },
  { timestamp: T0 + 4_000, speaker: "user" as const, text: "What's the", isFinal: false },
  { timestamp: T0 + 5_000, speaker: "user" as const, text: "What's the weather?", isFinal: true },
  { timestamp: T0 + 6_000, speaker: "user" as const, text: "In Knoxville.", isFinal: true },
  { timestamp: T0 + 7_000, speaker: "bot" as const, text: "Sunny and 60.", isFinal: true },
];

describe("CallMirror", () => {
  it("opens the conversation when the call is answered and links the voice session to it", async () => {
    const { store, calls } = fakeStore({ userId: "user-zach", name: "Zach" });
    const index = new VoiceConversationIndex();
    const { m } = mirror(store, { index });
    await m.handle(call());
    expect(calls.conversations).toEqual([{ userId: "user-zach", title: "Phone call from Zach" }]);
    expect(index.get("voice:19016512542")).toBe("conv-1");
    expect(index.get("agent:main:voice:19016512542")).toBe("conv-1");
    // Further snapshots of the live call open nothing new.
    await m.handle(call({ state: "speaking" }));
    expect(calls.conversations).toHaveLength(1);
    expect(calls.messages).toHaveLength(0);
  });

  it("at hang-up writes the transcript turns, the summary and a memory — once", async () => {
    const { store, calls } = fakeStore();
    const index = new VoiceConversationIndex();
    const { m, requests } = mirror(store, { index });
    await m.handle(call());
    const ended = call({ state: "hangup-user", endedAt: T0 + 95_000, endReason: "hangup-user", transcript: TRANSCRIPT });
    await m.handle(ended);
    await m.handle(ended); // duplicate snapshot
    expect(calls.conversations[0]!.title).toBe("Phone call from (901) 651-2542");
    expect(calls.messages.map((x) => [x.role, x.content])).toEqual([
      ["assistant", "Hi, this is Frank."],
      ["user", "What's the weather? In Knoxville."],
      ["assistant", "Sunny and 60."],
      ["assistant", "Call ended · 1m 33s · hangup-user\n\nZach asked for the weather. Frank answered."],
    ]);
    expect(calls.messages[0]).toMatchObject({ senderKind: "agent", senderId: "frank", at: T0 + 3_000 });
    expect(calls.messages[1]).toMatchObject({ at: T0 + 5_000 }); // first final line of the turn
    expect(calls.messages[3]).toMatchObject({ at: T0 + 95_000 }); // summary at hang-up
    expect(calls.messages[1]).toMatchObject({ senderKind: "user", senderId: null });
    expect(calls.memories).toHaveLength(1);
    expect(calls.memories[0]).toMatchObject({ conversationId: "conv-1", tags: ["phone-call"] });
    expect(calls.memories[0]!.body).toMatch(/^Phone call from \(901\) 651-2542 on 2026-11-18 \(1m 33s\): Zach asked/);
    expect(requests).toHaveLength(1);
    // The link outlives the call briefly, for a consult still running.
    expect(index.get("voice:19016512542")).toBe("conv-1");
  });

  it("a call first seen already ended is still recorded", async () => {
    const { store, calls } = fakeStore();
    const { m } = mirror(store);
    await m.handle(call({ state: "completed", endedAt: T0 + 30_000, transcript: TRANSCRIPT }));
    expect(calls.conversations).toHaveLength(1);
    expect(calls.messages.length).toBe(4);
  });

  it("no summary or memory when the caller never spoke (e.g. a notify smoke call)", async () => {
    const { store, calls } = fakeStore();
    const { m, requests } = mirror(store);
    await m.handle(
      call({
        direction: "outbound",
        from: "+18653501221",
        to: "+19016512542",
        state: "hangup-bot",
        endedAt: T0 + 10_000,
        transcript: [{ timestamp: T0, speaker: "bot", text: "OpenClaw voice call smoke test.", isFinal: true }],
      }),
    );
    expect(calls.conversations[0]!.title).toBe("Phone call to (901) 651-2542");
    expect(requests).toHaveLength(0);
    expect(calls.memories).toHaveLength(0);
    expect(calls.messages.at(-1)).toMatchObject({ content: "Call ended · 8s", systemGenerated: true });
  });

  it("a failed summary still records the call, without a memory", async () => {
    const { store, calls } = fakeStore();
    const { m } = mirror(store, { summary: null });
    await m.handle(call({ state: "completed", endedAt: T0 + 30_000, transcript: TRANSCRIPT }));
    expect(calls.messages.at(-1)!.content).toBe("Call ended · 28s");
    expect(calls.memories).toHaveLength(0);
  });

  it("calls nobody answered are ignored", async () => {
    const { store, calls } = fakeStore();
    const { m } = mirror(store);
    await m.handle(call({ answeredAt: undefined, state: "no-answer", endedAt: T0 + 30_000 }));
    expect(calls.conversations).toHaveLength(0);
  });
});

describe("caller identity", () => {
  it("a selected member is matched from the spec, named, filed under them and looked up by the plugin", async () => {
    const { store, calls } = fakeStore(null);
    const index = new VoiceConversationIndex();
    const m = new CallMirror({
      store,
      agentUid: "frank",
      scope: "per-phone",
      callers: [{ phone: "+19016512542", name: "Zach Tucker", userId: "user-zach" }],
      summarize: async () => null,
      index,
    });
    await m.handle(call());
    expect(calls.conversations).toEqual([{ userId: "user-zach", title: "Phone call from Zach Tucker" }]);
    expect(index.lookup("voice:19016512542")).toEqual({
      conversation_id: "conv-1",
      caller: { name: "Zach Tucker", phone: "+1 901-651-2542", member: true },
    });
  });

  it("before the mirror links the call, known callers still resolve by number", () => {
    const index = new VoiceConversationIndex();
    index.setKnownCallers([{ phone: "+19016512542", name: "Zach Tucker", userId: "u" }]);
    expect(index.lookup("voice:19016512542")).toEqual({
      conversation_id: null,
      caller: { name: "Zach Tucker", phone: "+1 901-651-2542", member: true },
    });
    expect(index.lookup("voice:15550001111").caller).toEqual({
      name: null,
      phone: "+1 555-000-1111",
      member: false,
    });
    expect(index.lookup("webchat:c")).toEqual({ conversation_id: null, caller: null });
  });
});

describe("phone conversations", () => {
  it("byConversation reports the call (live, then ended) and the index answers webchat lookups", async () => {
    const { store } = fakeStore({ userId: "user-zach", name: "Zach Tucker" });
    const index = new VoiceConversationIndex();
    const { m } = mirror(store, { index });
    index.attach(m, true);
    await m.handle(call());
    expect(m.byConversation("conv-1")).toEqual({
      callId: "call-1",
      conversationId: "conv-1",
      party: "+19016512542",
      who: "Zach Tucker",
      userId: "user-zach",
      live: true,
    });
    expect(index.lookup("webchat:conv-1")).toEqual({
      conversation_id: "conv-1",
      caller: { name: "Zach Tucker", phone: "+1 901-651-2542", member: true },
      phone_record: { live: true, sms: true },
    });
    await m.handle(call({ state: "completed", endedAt: T0 + 30_000, transcript: TRANSCRIPT }));
    expect(m.byConversation("conv-1")!.live).toBe(false);
    expect(index.lookup("webchat:other")).toEqual({ conversation_id: null, caller: null });
  });
});

describe("dropRestatedPrefix", () => {
  it("fixes the partial+final restatement from the live call", () => {
    const heard =
      "Can you delegate a task to the Bacon 's sales assistant to see how many Can you delegate a task to the " +
      "Bacon's sales assistant to see how many Sales orders we confirmed today. Just delegate that task.";
    expect(dropRestatedPrefix(heard)).toBe(
      "Can you delegate a task to the Bacon's sales assistant to see how many Sales orders we confirmed today. Just delegate that task.",
    );
  });

  it("leaves ordinary speech alone", () => {
    for (const t of ["thank you thank you so much", "Sunny and 60.", "Call me back about the order and the order total."]) {
      expect(dropRestatedPrefix(t)).toBe(t);
    }
  });
});

describe("CallLogTail", () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("follows appended snapshots, handles a partial last line and resumes after a restart", async () => {
    dir = await mkdtemp(join(tmpdir(), "knox-calls-"));
    const log = join(dir, "calls.jsonl");
    await appendFile(log, `${JSON.stringify(call({ callId: "old", state: "completed", endedAt: T0 }))}\n`);

    const { store, calls } = fakeStore();
    const tail = new CallLogTail(dir, mirror(store).m);
    await tail.start(); // first run starts at the end: the old call is not replayed
    tail.stop();
    expect(calls.conversations).toHaveLength(0);

    const live = JSON.stringify(call());
    await appendFile(log, `${live}\n${live.slice(0, 20)}`);
    await tail.tick();
    expect(calls.conversations).toHaveLength(1);
    await appendFile(log, `${live.slice(20)}\n`);
    await tail.tick();
    expect(calls.conversations).toHaveLength(1);

    // Restart: a new tail on the same dir picks up the saved offset and state.
    const saved = JSON.parse(await readFile(join(dir, "knox-call-mirror.json"), "utf8"));
    expect(saved.calls["call-1"].conversationId).toBe("conv-1");
    const tail2 = new CallLogTail(dir, mirror(store).m);
    await tail2.start();
    tail2.stop();
    await appendFile(log, `${JSON.stringify(call({ state: "completed", endedAt: T0 + 30_000, transcript: TRANSCRIPT }))}\n`);
    await tail2.tick();
    expect(calls.conversations).toHaveLength(1); // reused, not reopened
    expect(calls.messages.length).toBe(4);
    expect(calls.messages.every((x) => x.conversationId === "conv-1")).toBe(true);
  });
});

describe("helpers", () => {
  it("consultSessionKey mirrors the plugin's per-phone / per-call keys", () => {
    expect(consultSessionKey(call(), "per-phone")).toBe("voice:19016512542");
    expect(consultSessionKey(call(), "per-call")).toBe("voice:call:call-1");
    expect(consultSessionKey(call({ sessionKey: "voice:custom" }), "per-phone")).toBe("voice:custom");
    expect(
      consultSessionKey(call({ direction: "outbound", from: "+18653501221", to: "+15550001111" }), "per-phone"),
    ).toBe("voice:15550001111");
  });

  it("voiceSessionTail / prettyPhone / formatDuration / transcriptTurns", () => {
    expect(voiceSessionTail("agent:main:voice:call:x")).toBe("voice:call:x");
    expect(voiceSessionTail("webchat:c")).toBeNull();
    expect(prettyPhone("+19016512542")).toBe("(901) 651-2542");
    expect(prettyPhone("+447700900123")).toBe("+447700900123");
    expect(formatDuration(5_400)).toBe("5s");
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(transcriptTurns(TRANSCRIPT).map((t) => t.at)).toEqual([T0 + 3_000, T0 + 5_000, T0 + 7_000]);
  });

  it("summary request + cleanup", () => {
    const req = buildSummaryRequest(transcriptTurns(TRANSCRIPT), {
      direction: "Inbound",
      party: "Zach",
      duration: "1m 33s",
    });
    const msg = (req.messages as Array<{ content: string }>)[0]!.content;
    expect(msg).toContain("Caller: What's the weather? In Knoxville.");
    expect(msg).toContain("Agent: Sunny and 60.");
    expect(cleanSummary("<think>hmm</think>  Short call.")).toBe("Short call.");
    expect(cleanSummary("<think>never closed")).toBeNull();
  });

  it("an ended call's link expires", () => {
    const idx = new VoiceConversationIndex();
    idx.set("voice:1", "c");
    idx.release("voice:1", 0);
    expect(idx.get("voice:1", 1)).toBe("c");
    expect(idx.get("voice:1", 16 * 60_000)).toBeNull();
  });
});
