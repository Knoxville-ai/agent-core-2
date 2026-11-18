// Dependency-free logic for the knox-voice-context plugin, split out from
// index.js so it can be unit-tested without loading the OpenClaw SDK.

/** True for a voice-call session key (`voice:…`, however it is prefixed). */
export function isVoiceSessionKey(sessionKey) {
  return typeof sessionKey === "string" && /(^|:)voice:/.test(sessionKey);
}

/**
 * The context prepended to a mid-call consult. `info` is the shim's
 * /internal/voice-conversation answer: `{ conversation_id, caller }` where
 * caller is `{ name, phone, member }` or null for an unknown number.
 */
export function buildVoiceContext(info) {
  const caller = info?.caller ?? null;
  const lines = ["## Live phone call"];
  if (caller?.name) {
    lines.push(
      `You are on a live phone call with ${caller.name}${caller.phone ? ` (${caller.phone})` : ""}` +
        (caller.member ? ", a member of your organization." : ".") +
        " Treat the request as coming from them.",
    );
  } else if (caller?.phone) {
    lines.push(`You are on a live phone call with an unknown caller at ${caller.phone}.`);
  } else {
    lines.push("You are on a live phone call.");
  }
  lines.push(
    "Your reply is spoken aloud by the voice on the line: answer in a sentence or two, plain words, no lists or links.",
    "Work that will take more than a few seconds must not keep the caller waiting: start it with `start_task` " +
      "(`self: true` to do it yourself, or the target agent to delegate) and reply with what you started. " +
      "The result is delivered to this call's conversation in the console when it lands.",
    "If you already started this same work earlier in this call, don't start it again: say it's already running.",
    "Only say something was started or done if the tool call actually succeeded; if it failed, say so.",
  );
  return lines.join("\n");
}
