# Bring your own agent (BYOA) — drive thru endpoint contract

This document is the **wire contract** an externally-hosted agent must
implement to be listed as a self-hosted "drive thru" on the
knoxville-ai-console. It is the source-of-truth counterpart to the
user-facing spec page the console renders at `/drive-throughs/byoa`.

An openclaw vessel (this image) already speaks this contract — the
console-facing HTTP surface in `README.md` / `CONSOLE_INTEGRATION.md` is a
**superset** of what's required here. BYOA exists so a third party can
implement the same tiny surface on _their own_ stack (Claude Agent SDK,
Codex, LangGraph, a plain web framework) and have the platform proxy
conversations to it.

> **Any change to this contract must land in both `agent-core` and
> `knoxville-ai-console` in the same PR** (see the console's `CONTRACT.md`).

## Routing model (console side)

A BYOA listing is backed by a normal `public.agents` row flagged
`is_external = true`, whose `gateway_url` is the owner's endpoint base URL.
Because the listing's `source_agent_uid` then points at a real agent row,
every existing routing path (conversations, messages, `mcp_tasks`,
metrics, the MCP `agent-bridge`) works unchanged. The endpoint's shared
secret is stored, encrypted, in `public.external_agent_endpoints`
(service-role only) — never on the agents row.

When the platform proxies a turn it:

1. resolves the listing → backing external agent → endpoint URL + secret;
2. `POST`s the user message to the endpoint with the shared secret as a
   bearer and caller context as `X-Knox-*` headers;
3. reads the reply (JSON or SSE) and returns it to the original caller
   (an LLM client, a website visitor, a QR/SMS session, or another agent).

## Endpoints the external host implements

### `POST <your messaging endpoint>` — required

One user turn. The platform POSTs directly to the URL the owner registers —
**no path structure is imposed**. The conversation id is not a resource in
the path; it travels as a body param + header the agent may use or ignore,
so the host is free to organize history however it already does (per
session, per user, or stateless).

Request headers:

```
Authorization: Bearer <shared secret>      # the value set on the listing
Content-Type: application/json
Accept: text/event-stream, application/json
X-Knox-Conversation-Id: <uuid>             # opaque correlation token
X-Knox-Caller-Kind: user | anonymous | agent
X-Knox-Caller-Id: <opaque stable caller id>
X-Knox-Caller-Email: <email>               # signed-in users only
```

Request body:

```json
{
  "content": "…user message…",
  "conversation_id": "…",   // opaque token — thread on it or ignore it
  "caller_kind": "anonymous",
  "caller_id": "…"
}
```

Response — **either** of:

- **JSON** (`Content-Type: application/json`):
  `{ "reply": "…" }` (also accepts `text` / `content` / `message`).
  Signal failure with `{ "error": "…" }` or a non-2xx status.
- **SSE** (`Content-Type: text/event-stream`):
  ```
  data: {"type":"token","delta":"…"}
  data: {"type":"done","status":"complete"}
  ```
  `done.status ∈ { complete, interrupted, error }`; a hard mid-stream
  failure is `{"type":"error","error":"…"}`.

The listing's **response mode** (`auto` | `json` | `sse`, default `auto`)
controls how the platform reads the response. `auto` negotiates on the
response `Content-Type`.

**openclaw vessels / path-based routing.** If the host wants the
conversation id in the path (e.g. pointing the platform straight at an
openclaw vessel's `/api/v1/conversations/{id}/messages`), register a
messaging URL containing a `{conversation_id}` placeholder and the platform
substitutes it. Absent the placeholder, the platform POSTs flat.

### `GET {base}/healthz` — recommended

`200` when the agent is up.

### Long-running tasks — not yet

`start_task` against a BYOA drive thru currently returns a clear "not
supported yet" error. Async tasks need a result-callback API (so the
external agent can report progress back into `public.mcp_tasks`, which it
can't write to directly); that's roadmap, not contract. Synchronous
`send_message` chat is unaffected.

## Authentication

The platform presents the **owner-set shared secret** as a bearer on every
call. The host verifies it and rejects mismatches with `401`. The platform
does not share `SUPABASE_JWT_SECRET` with external hosts (an HS256 token
they couldn't verify anyway) — the shared secret is the trust anchor.

## Conversation semantics

- `conversation_id` is a stable, opaque correlation token in the body (and
  the `X-Knox-Conversation-Id` header). It is a convenience, not a contract:
  thread on it for continuity, or ignore it and run stateless. The platform
  never replays prior turns.
- `caller_kind`: `user` (signed-in Knoxville user), `anonymous` (public
  website / QR visitor, no account), `agent` (agent-to-agent call).
- `caller_id` is a stable opaque id — fine for per-caller memory / rate
  limiting; it is not an email or account id.
