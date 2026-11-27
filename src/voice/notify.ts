import { execFile } from "node:child_process";
import { dirname, join } from "node:path";

import { log } from "../log.js";
import type { AgentEnv } from "../env.js";
import { childEnv } from "../openclaw/child-env.js";
import { displayE164, type PhoneConversation } from "./call-mirror.js";

/**
 * Getting the result of phone-started work back to the caller.
 *
 * A task started during a call (`start_task`, stamped with the call's console
 * conversation) wakes the agent in that conversation when it lands — the
 * agent writes the result there, and nobody on the phone hears it. The
 * notifier closes that gap, deterministically rather than by hoping the model
 * reaches for a tool: when a task-result turn finishes in a phone call's
 * conversation it delivers the agent's reply to the caller —
 *   - still on the line → spoken on the call (`openclaw voicecall speak`, the
 *     plugin's realtime "say this now"), so they don't have to keep asking;
 *   - call over → texted to them (Telnyx Messaging), when the agent's phone
 *     has SMS on and the number is one the agent knows (a known caller or on
 *     the allowlist — never an arbitrary number).
 * Each delivery (or failure) leaves a one-line note in the conversation.
 */

/** The console's wake-up for a finished task (lib/tasks/callback.ts). */
export const TASK_CALLBACK_PREFIX = "[task-callback]";
/** The console's notice that work started on a call is waiting on the caller
 *  (lib/escalations/phone.ts, 0218). */
export const ESCALATION_RAISED_PREFIX = "[escalation-raised]";

export interface TurnCompleteInfo {
  conversationId: string;
  /** The user-side content that started the turn. */
  userContent: string;
  /** The agent's visible reply. */
  reply: string;
  status: "complete" | "interrupted" | "error";
}

/** Markdown → something that reads well aloud or in a text. */
export function plainText(markdown: string, max: number): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, "") // table rules
    .replace(/\|/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*[-*]\s+/gm, "- ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export interface PhoneNotifierDeps {
  /** The call a console conversation records, if any. */
  byConversation: (conversationId: string) => PhoneConversation | null;
  /** Say something on a live call now. */
  speak: (callId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  /** Send a text; null when the agent's phone has SMS off. */
  sms: ((to: string, text: string) => Promise<{ ok: boolean; error?: string }>) | null;
  /** Numbers the agent may text (known callers + allowlist), E.164. */
  textable: ReadonlySet<string>;
  /** Leave a one-line note in the conversation. */
  note: (conversationId: string, text: string) => Promise<void>;
  agentName: string;
}

export class PhoneNotifier {
  constructor(private readonly deps: PhoneNotifierDeps) {}

  /** Never throws. Returns what it did, for tests and logs. */
  async handle(info: TurnCompleteInfo): Promise<"spoken" | "texted" | "skipped" | "failed"> {
    try {
      if (info.status !== "complete") return "skipped";
      const head = info.userContent.trimStart();
      const question = head.startsWith(ESCALATION_RAISED_PREFIX);
      if (!question && !head.startsWith(TASK_CALLBACK_PREFIX)) return "skipped";
      const reply = info.reply.trim();
      if (!reply) return "skipped";
      const call = this.deps.byConversation(info.conversationId);
      if (!call) return "skipped";

      if (call.live) {
        const said = await this.deps.speak(
          call.callId,
          question
            ? "Something you started for the caller is waiting on their decision. Ask them now, briefly, with the choices " +
                "(for an approval, they also need to say their phone PIN), then consult the agent with their answer so it " +
                `can record it:\n${plainText(reply, 1200)}`
            : "A result you were waiting on just came in. Tell the caller now, in one or two short spoken sentences, " +
                `then ask if they need anything else:\n${plainText(reply, 1200)}`,
        );
        if (said.ok) {
          await this.deps.note(info.conversationId, `Told ${call.who} on the call.`);
          log.info("phone result spoken", { conversation_id: info.conversationId, call_id: call.callId });
          return "spoken";
        }
        log.warn("phone result not spoken; falling back to text", { err: said.error });
      }

      if (!this.deps.sms) return "skipped";
      if (!this.deps.textable.has(call.party)) {
        await this.deps.note(info.conversationId, `Didn't text ${call.who}: not a known caller.`);
        return "skipped";
      }
      const name = this.deps.agentName.trim();
      const body = question
        ? `${plainText(reply, 800)}\nCall back to answer, or answer it in the console.`
        : plainText(reply, 1000);
      const sent = await this.deps.sms(call.party, `${name ? `${name}: ` : ""}${body}`);
      if (sent.ok) {
        await this.deps.note(info.conversationId, `Texted the result to ${call.who} (${displayE164(call.party)}).`);
        log.info("phone result texted", { conversation_id: info.conversationId });
        return "texted";
      }
      await this.deps.note(info.conversationId, `Couldn't text ${call.who}: ${sent.error ?? "unknown error"}`);
      log.warn("phone result text failed", { err: sent.error });
      return "failed";
    } catch (err) {
      log.error("phone notify failed", { err: String(err) });
      return "failed";
    }
  }
}

/** `openclaw voicecall speak` as the agent user, against the running gateway. */
export function cliSpeaker(env: AgentEnv) {
  return (callId: string, text: string) =>
    new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const stateDir = env.OPENCLAW_STATE_DIR;
      execFile(
        "openclaw",
        ["voicecall", "speak", "--call-id", callId, "--message", text],
        {
          timeout: 30_000,
          env: childEnv({
            HOME: dirname(stateDir),
            OPENCLAW_HOME: dirname(stateDir),
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
            TMPDIR: join(stateDir, "tmp"),
          }),
        },
        (err, stdout) => {
          if (err) return resolve({ ok: false, error: String(err.message).slice(0, 300) });
          if (/"success"\s*:\s*false/.test(stdout)) return resolve({ ok: false, error: stdout.trim().slice(0, 300) });
          resolve({ ok: true });
        },
      );
    });
}

/** Telnyx Messaging (v2). The number must be on a messaging profile — and, for
 *  US recipients, registered for 10DLC — or Telnyx/carriers reject the text. */
export function telnyxSms(
  from: string,
  apiKey: string,
  messagingProfileId: string | undefined,
  fetchImpl: typeof fetch = fetch,
) {
  return async (to: string, text: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetchImpl("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to,
          text,
          ...(messagingProfileId ? { messaging_profile_id: messagingProfileId } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return { ok: true };
      const body = (await res.json().catch(() => null)) as {
        errors?: Array<{ title?: string; detail?: string; code?: string }>;
      } | null;
      const e = body?.errors?.[0];
      return { ok: false, error: `Telnyx ${res.status}${e ? `: ${e.detail ?? e.title ?? ""} ${e.code ? `(${e.code})` : ""}` : ""}`.trim() };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  };
}

/** Process-wide hook the shim calls when a chat turn finishes (null = no phone). */
export const phoneNotify: { current: PhoneNotifier | null } = { current: null };
