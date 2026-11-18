import { describe, expect, it } from "vitest";

import { buildVoiceContext, isVoiceSessionKey } from "./context.js";

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
  });

  it("degrades to an unknown caller, then to nothing known", () => {
    expect(buildVoiceContext({ caller: { name: null, phone: "+15550001111", member: false } })).toContain(
      "unknown caller at +15550001111",
    );
    expect(buildVoiceContext(null)).toContain("You are on a live phone call.");
  });
});
