import { Agent, fetch as undiciFetch } from "undici";

/**
 * The streaming call to the LOCAL openclaw gateway, with undici's idle timeouts
 * disabled.
 *
 * Why this exists: openclaw emits no SSE data on the `/v1/chat/completions`
 * stream while the agent is inside a tool call or a slow model turn — the shim
 * only ever sees `delta.content`, and none flows during tool execution. A long
 * unattended run can therefore go many minutes with the response body completely
 * idle. Node's global `fetch` (undici) aborts a body that idle at its default
 * `bodyTimeout` of 300s, and the abort surfaces as `TypeError: terminated`.
 *
 * That is exactly how a healthy-but-quiet task run was being killed mid-work: the
 * shim reported the task `failed` with error "terminated" while openclaw was
 * still executing tools and eventually completed its run. A synchronous web-chat
 * turn dodged it only because the human paces the work into short, chatty turns
 * that never sit silent for 300s.
 *
 * A run that legitimately takes too long is already bounded by the task's
 * `deadline_at` and the platform's heartbeat reaper — the correct layers for
 * "this has gone on too long". A socket idle timer is not, so we disable
 * body/headers timeouts on THIS dispatcher only. `connectTimeout` still applies,
 * so a gateway that is actually down still fails fast, and every other `fetch` in
 * the process keeps undici's defaults (a genuinely stuck callback still times
 * out).
 */
const gatewayDispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 0 });

/**
 * `fetch` the openclaw gateway's streaming endpoint. Identical to a normal fetch
 * except it pins the no-idle-timeout dispatcher above. Use this for the
 * chat-completions stream; use plain `fetch` for everything else.
 */
export function fetchOpenclawStream(
  url: string,
  init: Parameters<typeof undiciFetch>[1],
): ReturnType<typeof undiciFetch> {
  return undiciFetch(url, { ...(init ?? {}), dispatcher: gatewayDispatcher });
}
