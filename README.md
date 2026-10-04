# agent-core (openclaw vessel)

> **Status:** v0.3 rewrite on `claude/vibrant-hamilton-Ml7Ad`. This branch
> replaces the previous Python/FastAPI agent runtime with a thin
> [openclaw](https://github.com/openclaw/openclaw)-backed vessel. See
> `CONSOLE_INTEGRATION.md` for the contract between this image and the
> knoxville-ai-console.

## What this image is

A general-purpose **openclaw agent vessel**. Every per-agent capability
(prompts, skills, MCP servers, model selection) is delivered at provision
time by env vars and Supabase Storage — there is no role-specific code in
this image.

The container runs two things:

1. **`openclaw gateway`** — the actual agent runtime, listening on a
   loopback WebSocket port (default 18789).
2. **Shim** (Node/TypeScript) — listens on `:8080` and exposes the HTTP
   surface the knoxville-ai-console already speaks. The shim translates
   each request into openclaw Gateway RPC calls and streams responses back
   as SSE.

```
console ──HTTPS─▶ shim :8080 ──WS──▶ openclaw gateway :18789
                       │
                       ├─ Supabase Storage  (workspace blobs + manifest)
                       └─ Supabase JWT      (verify caller bearer)
```

## What this image is NOT

- **Not role-coupled.** No `roles/`, no `app/odoo`, no `app/ebay`. Domain
  logic lives in openclaw skills installed into `~/.openclaw/workspace/skills/`,
  shipped per-agent from the platform's skills library rather than baked into
  the image (see *Skills* below).
- **Not a native messaging endpoint.** openclaw's Telegram / Slack /
  Discord / WhatsApp adapters are not configured. All conversation flow
  routes through the platform — either the console's chat UI or external
  callers reaching this agent via the platform's MCP layer.

## Provisioning contract

Required env vars (set by the console — see `.env.example` for the full
list):

| Var | Purpose |
| --- | --- |
| `AGENT_UID` / `AGENT_ORG` / `AGENT_ROLE` | identity; `AGENT_ROLE=generic` for vessel agents |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Storage access for workspace + manifest |
| `SUPABASE_JWT_SECRET` | HS256 secret used to verify the console's bearer JWTs |
| `OPENCLAW_GATEWAY_TOKEN` | shared secret between shim and local openclaw gateway |
| `LLM_PROVIDER` / `LLM_MODEL` / `LLM_API_KEY` | written into `openclaw.json` as the primary model |
| `LLM_BASE_URL` | optional provider endpoint override (`models.providers.<provider>.baseURL`). Point at a cheap external OpenAI-compatible endpoint (Groq/DeepSeek/self-hosted Ollama box), or leave unset for `LLM_PROVIDER=ollama` to run a small model in-container (weights pulled on first boot, ollama agents only) |
| `PLATFORM_MCP_URL` / `PLATFORM_API_TOKEN` | optional; attaches the platform MCP server for A2A discovery and is used at boot to call `get_my_bundle` for capability assignments, and by SkillSync for the skill plan |
| `OPENCLAW_BUNDLED_SKILLS` | optional; openclaw bundled skills the agent may see (`skills.allowBundled`). Default `skill-creator`; `none` = no bundled skills; `all` = openclaw's default (every eligible bundled skill in every prompt). Gateway start only |
| `SKILL_SYNC_POLL_MS` | optional; SkillSync safety-poll interval, default `300000` (5 min); `0` disables |

Workspace blobs (pulled from Supabase Storage at boot, all optional):

| Path in `agent-data/orgs/{org}/agents/{uid}/` | Becomes |
| --- | --- |
| `memory/system_prompt.md` | `workspace/SOUL.md` |
| `memory/identity.md` | `workspace/AGENTS.md` |
| `memory/boot.md` | `workspace/TOOLS.md` |
| `memory/playbook.md` | `workspace/playbook.md` |

## Skills

Skills are reconciled, not reinstalled. When the platform MCP is configured and
the console serves the skills library, **SkillSync** (`src/skills/sync.ts`)
makes `workspace/skills/` match the agent's desired skills: it asks the console
for a plan (`get_skill_sync_plan`), downloads only the file blobs it doesn't
have (each sha256-verified), writes each version into a staging folder,
installs its Python deps (`install.uv`), swaps it in with a rename, and records
it in `$OPENCLAW_STATE_DIR/platform-skills.lock.json`. It runs at boot (no wipe;
the lock means only changes are fetched), on a `POST /skills/sync` nudge from the
console, and on a 5-minute poll.

The running gateway is **never restarted** for a skill change: SkillSync bumps
`skills.entries.<key>.config.rev` in `openclaw.json`, which openclaw
(`gateway.reload.mode: "hot"`) hot-reloads, and every session — existing ones
included — lists the change from its next turn. Folders the platform didn't put
under `skills/` are moved to `workspace/.skills-unmanaged/` and reported.

An older console (no `get_skill_sync_plan`) or a vessel without the platform MCP
uses the legacy path: wipe, then install the bundle's ClawHub skills and the
console boot list (`config/skills.json`) at boot. See `CONSOLE_INTEGRATION.md`
*Skills* for the full contract.

## HTTP surface (port 8080)

All authenticated endpoints require `Authorization: Bearer <Supabase
session.access_token>`, verified against `SUPABASE_JWT_SECRET`.

| Method + path | Purpose |
| --- | --- |
| `GET  /healthz` | container liveness |
| `GET  /readyz` | gateway readiness (200 once openclaw is connected) |
| `POST /api/v1/conversations/:id/messages` | send a user turn; response is SSE (`delta` / `tool_call` / `tool_result` / `done` / `error`) |
| `POST /api/v1/conversations/:id/interrupt` | abort an in-flight turn |
| `POST /skills/sync` | gateway-token auth; the console's skills nudge — `200 applied` / `202 in_progress` / `409 legacy` |
| `GET  /skills` | gateway-token auth; installed skills (the SkillSync lock, or the folders in legacy mode) |
| `*    /api/v1/agents/:uid/files/...` | placeholder (501) — file attachments TBD |

## Local development

```sh
# Install deps + build (Node 22.19+ or 24 recommended)
npm install
npm run build

# Run locally — you'll need a Supabase project and a SUPABASE_JWT_SECRET
cp .env.example .env
# edit .env, then:
npm start
```

## Docker

```sh
docker build -t ghcr.io/knoxville-ai/agent-core:0.3.0-openclaw .
docker run --rm -p 8080:8080 --env-file .env ghcr.io/knoxville-ai/agent-core:0.3.0-openclaw
```

## Migration notes from v0.2.x

- `roles/`, `app/`, `agent_core/`, `tests/`, `pyproject.toml`,
  `requirements.txt`, and `supervisord.conf` have all been removed. Role
  logic that was previously code in this repo will be re-introduced as
  openclaw skills, one role at a time, in follow-up PRs. The legacy image
  (`agent-core:0.2.x`) remains valid for already-provisioned agents — the
  console selects the image per-agent via `source_image_tag`.
- The HTTP surface is **wire-compatible** with the existing console
  messaging proxy. Migrating an agent is a matter of redeploying with a
  new `source_image_tag` and the appropriate env vars.

## Verification status

This rewrite is a clean-room implementation against the openclaw public
docs. A few specifics will need verification against a real openclaw
deployment:

1. **Gateway WS auth handshake** — the docs confirm `gateway.auth.token`
   exists but didn't pin down whether the token is sent on the WS upgrade
   header, inside the `connect` request body, or both. The client
   (`src/openclaw/gateway-client.ts`) sends it both ways. If openclaw
   rejects one form, drop it.
2. **Event names** — the routing in `src/shim/routes-messages.ts` accepts
   both `session.*` and `chat.*` event prefixes that appear in the docs.
   Real event names from a live gateway may need narrowing.
3. **`sessions.create` idempotency** — assumed; treats "already exists"
   errors as success. Adjust if the live gateway returns a different
   shape.
