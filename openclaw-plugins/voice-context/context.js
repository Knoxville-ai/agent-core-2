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
      `You are on a live phone call from ${caller.phone || "a number"} that matches ${caller.name}` +
        (caller.member ? ", a member of your organization." : ".") +
        " Caller ID can be faked, so it doesn't prove who is speaking: until they confirm their phone PIN you can " +
        "answer questions and help with what the call is already waiting on, but not act for them. As soon as they " +
        "want something done, ask for their phone PIN and call `verify_caller_pin` with the digits they say. " +
        "Once it's confirmed, treat the request as coming from them.",
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
    "When you start a task from this call, add to its instructions: \"Requested on a phone call: if you need a " +
      "decision, ask one short question with two or three clear options.\"",
    "If work started on this call is waiting on a decision or approval, read it with `list_call_escalations` and, " +
      "once the caller has answered, record exactly their answer with `answer_call_escalation` — never decide for them. " +
      "Approving also needs the caller's phone PIN (`pin`, the digits they said). Don't send them to the console, and " +
      "don't use `escalate_to_human` to ask the person you're already talking to — ask them directly.",
    "Only say something was started or done if the tool call actually succeeded; if it failed, say so.",
  );
  return lines.join("\n");
}

/** True for the webchat session of a console conversation (where task results
 *  for a phone call's conversation arrive). */
export function isWebchatSessionKey(sessionKey) {
  return typeof sessionKey === "string" && /(^|:)webchat:/.test(sessionKey);
}

/**
 * Context for a turn in a phone call's console conversation — typically the
 * result of work started on the call coming back. `info.phone_record` is
 * `{ live, sms }` from the shim; null/absent means "not a phone call".
 */
export function buildPhoneRecordContext(info) {
  const rec = info?.phone_record;
  if (!rec) return null;
  const caller = info.caller ?? {};
  const who = caller.name || caller.phone || "the caller";
  const delivery = rec.live
    ? "it is spoken to them on the call right away"
    : rec.sms
      ? "it is texted to them"
      : "they will see it here in the console";
  return [
    "## This conversation is a phone call",
    `This conversation is the record of a phone call with ${who}` +
      (caller.phone && caller.name ? ` (${caller.phone})` : "") +
      (caller.member ? ", a member of your organization" : "") +
      `. ${rec.live ? "They are still on the line." : "The call has ended."}`,
    `When work you started for them comes back here, write the result for them briefly and plainly — the platform delivers your reply: ${delivery}. ` +
      "You don't need to text, call or escalate it yourself, and don't say you can't reach them.",
    "If this turn says work is waiting on them (`[escalation-raised]`), write the question for them: what's waiting and the " +
      "choices, in a sentence or two — and, for an approval, that they'll need to say their phone PIN. Don't tell them to go to the console.",
  ].join("\n");
}
