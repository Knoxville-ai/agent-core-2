import { describe, expect, it } from "vitest";

import { buildPhoneRecordContext, buildVoiceContext, isVoiceSessionKey, isWebchatSessionKey } from "./context.js";

describe("knox-voice-context", () => {
  it("only voice sessions get context", () => {
    expect(isVoiceSessionKey("voice:19016512542")).toBe(true);
    expect(isVoiceSessionKey("agent:main:voice:call:x")).toBe(true);
    expect(isVoiceSessionKey("webchat:c")).toBe(false);
  });

  it("names a known member", () => {
    const text = buildVoiceContext({
      conversation_id: "c",
      caller: { name: "Zach Tucker", phone: "+1 901-651-2542", member: true },
    });
    expect(text).toContain("live phone call with Zach Tucker (+1 901-651-2542), a member of your organization.");
    expect(text).toContain("start_task");
    expect(text).toContain("answer_call_escalation");
    expect(text).toContain("phone PIN");
  });

  it("degrades to an unknown caller, then to nothing known", () => {
    expect(buildVoiceContext({ caller: { name: null, phone: "+15550001111", member: false } })).toContain(
      "unknown caller at +15550001111",
    );
    expect(buildVoiceContext(null)).toContain("You are on a live phone call.");
  });

  it("a phone call's conversation tells the agent its reply reaches the caller", () => {
    expect(isWebchatSessionKey("webchat:conv-1")).toBe(true);
    const caller = { name: "Zach Tucker", phone: "+1 901-651-2542", member: true };
    const live = buildPhoneRecordContext({ caller, phone_record: { live: true, sms: true } });
    expect(live).toContain("They are still on the line.");
    expect(live).toContain("spoken to them on the call");
    expect(buildPhoneRecordContext({ caller, phone_record: { live: false, sms: true } })).toContain("texted to them");
    expect(buildPhoneRecordContext({ caller, phone_record: { live: false, sms: false } })).toContain("here in the console");
    expect(buildPhoneRecordContext({ conversation_id: null, caller: null })).toBeNull();
  });
});
