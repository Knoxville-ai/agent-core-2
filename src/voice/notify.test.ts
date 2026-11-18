import { describe, expect, it } from "vitest";

import type { PhoneConversation } from "./call-mirror.js";
import { PhoneNotifier, plainText, telnyxSms, type PhoneNotifierDeps } from "./notify.js";

const CALL: PhoneConversation = {
  callId: "call-1",
  conversationId: "conv-1",
  party: "+19016512542",
  who: "Zach Tucker",
  userId: "u-1",
  live: false,
};
const RESULT = {
  conversationId: "conv-1",
  userContent: '[task-callback] Task t-1 ("Sales") complete.\nTotal: $41,714.70',
  reply: "Today's confirmed sales: **$41,714.70** across 189 orders.",
  status: "complete" as const,
};

function notifier(over: Partial<PhoneNotifierDeps> & { call?: PhoneConversation | null } = {}) {
  const log = { spoken: [] as string[], texts: [] as Array<[string, string]>, notes: [] as string[] };
  const deps: PhoneNotifierDeps = {
    byConversation: () => (over.call === undefined ? CALL : over.call),
    speak: async (_id, text) => {
      log.spoken.push(text);
      return { ok: true };
    },
    sms: async (to, text) => {
      log.texts.push([to, text]);
      return { ok: true };
    },
    textable: new Set(["+19016512542"]),
    note: async (_c, text) => {
      log.notes.push(text);
    },
    agentName: "Frank",
    ...over,
  };
  return { n: new PhoneNotifier(deps), log };
}

describe("PhoneNotifier", () => {
  it("call over → texts the known caller the plain result and leaves a note", async () => {
    const { n, log } = notifier();
    expect(await n.handle(RESULT)).toBe("texted");
    expect(log.texts).toEqual([["+19016512542", "Frank: Today's confirmed sales: $41,714.70 across 189 orders."]]);
    expect(log.notes).toEqual(["Texted the result to Zach Tucker (+1 901-651-2542)."]);
  });

  it("still on the line → spoken on the call, not texted", async () => {
    const { n, log } = notifier({ call: { ...CALL, live: true } });
    expect(await n.handle(RESULT)).toBe("spoken");
    expect(log.spoken[0]).toContain("$41,714.70");
    expect(log.texts).toHaveLength(0);
    expect(log.notes).toEqual(["Told Zach Tucker on the call."]);
  });

  it("speaking fails → falls back to a text", async () => {
    const { n, log } = notifier({
      call: { ...CALL, live: true },
      speak: async () => ({ ok: false, error: "No active realtime bridge" }),
    });
    expect(await n.handle(RESULT)).toBe("texted");
    expect(log.texts).toHaveLength(1);
  });

  it("only task results, only phone conversations, only finished replies", async () => {
    expect(await notifier().n.handle({ ...RESULT, userContent: "hello" })).toBe("skipped");
    expect(await notifier({ call: null }).n.handle(RESULT)).toBe("skipped");
    expect(await notifier().n.handle({ ...RESULT, status: "error" })).toBe("skipped");
    expect(await notifier().n.handle({ ...RESULT, reply: "  " })).toBe("skipped");
  });

  it("SMS off → nothing sent; unknown number → refused with a note", async () => {
    const off = notifier({ sms: null });
    expect(await off.n.handle(RESULT)).toBe("skipped");
    const stranger = notifier({ textable: new Set() });
    expect(await stranger.n.handle(RESULT)).toBe("skipped");
    expect(stranger.log.texts).toHaveLength(0);
    expect(stranger.log.notes[0]).toMatch(/not a known caller/);
  });

  it("a failed text is noted with the reason", async () => {
    const { n, log } = notifier({ sms: async () => ({ ok: false, error: "Telnyx 400: not 10DLC registered" }) });
    expect(await n.handle(RESULT)).toBe("failed");
    expect(log.notes[0]).toBe("Couldn't text Zach Tucker: Telnyx 400: not 10DLC registered");
  });
});

describe("plainText", () => {
  it("strips markdown and tables, and truncates", () => {
    expect(plainText("## Total\n| a | b |\n|---|---|\n| **1** | `2` |", 100)).toBe("Total\n a b \n\n 1 2");
    expect(plainText("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("telnyxSms", () => {
  it("posts the message and reports Telnyx's error detail", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const okFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await telnyxSms("+18653501221", "KEY", "mp-1", okFetch)("+19016512542", "hi")).toEqual({ ok: true });
    expect(calls[0]).toEqual({
      url: "https://api.telnyx.com/v2/messages",
      body: { from: "+18653501221", to: "+19016512542", text: "hi", messaging_profile_id: "mp-1" },
    });
    const badFetch = (async () =>
      new Response(JSON.stringify({ errors: [{ code: "40010", detail: "Not 10DLC registered" }] }), {
        status: 400,
      })) as unknown as typeof fetch;
    expect(await telnyxSms("+1", "K", undefined, badFetch)("+2", "x")).toEqual({
      ok: false,
      error: "Telnyx 400: Not 10DLC registered (40010)",
    });
  });
});
