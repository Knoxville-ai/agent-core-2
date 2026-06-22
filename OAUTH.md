# Model-provider OAuth (OpenAI Codex / ChatGPT) for openclaw vessels

This document records how an agent deploys with **OAuth** for its model
provider instead of an API key, and the console flow that drives it.

It is grounded in the pinned CLI (`openclaw@2026.5.20`, see `Dockerfile`).
Behavior was verified by inspecting that exact package's bundled docs and
runtime.

## TL;DR

1. An agent is **provisioned with an API key** (platform-managed or BYO) so
   it boots usable immediately. OAuth can't run until the container is up.
2. Later, from the console, the operator **switches the running container to
   OAuth**. The container returns an authorize URL; the operator visits it,
   then pastes the post-consent **callback URL** back into the console; the
   container completes the exchange and stores the token.
3. The token is minted **inside the container** (OpenClaw owns the encrypted
   store + refresh), then **backed up to Supabase Storage** and **restored on
   every boot**, so OAuth survives redeploys.

OAuth here means **OpenAI Codex (ChatGPT OAuth)** specifically — that is the
provider OpenClaw supports with a remote/headless "paste the redirect URL"
flow. Anthropic "subscription auth" is a different mechanism (setup-token /
Claude-CLI reuse), not a callback paste, and is out of scope.

## Why it has to work this way

Two hard constraints, both confirmed against the pinned image:

1. **The OAuth callback can't reach the container.** OpenClaw's Codex flow
   tries to capture the callback on `http://127.0.0.1:1455/auth/callback`
   (PKCE, client `app_EMoamEEZ73f0CkXaXp7hrann`, authorize at
   `auth.openai.com/oauth/authorize`). That loopback is inside the Railway
   container, unreachable from the operator's browser — so we must use the
   documented **manual paste fallback**: "if callback can't bind (or you're
   remote/headless), paste the redirect URL/code."

2. **The container filesystem is ephemeral and model changes redeploy it.**
   A token minted on the container lives under `$OPENCLAW_STATE_DIR` and
   would be wiped by the next redeploy. So it must be persisted and restored.

### The persistence trick (what makes redeploys safe)

OpenClaw stores OAuth tokens in an **encrypted** auth-profile store
(`$OPENCLAW_STATE_DIR/agents/<id>/agent/auth-profiles.json`, AES-256-GCM).
The encryption key is derived from a **seed**:

```
key = sha256("openclaw:auth-profile-oauth:" + seed)
```

and the seed resolves from the env var **`OPENCLAW_AUTH_PROFILE_SECRET_KEY`**
(else an on-disk key file). By setting that env var to a **stable per-agent
secret**, the encrypted store becomes **portable**: we can upload it to
Storage and decrypt it again on a brand-new container. No plaintext token
ever leaves the container — only OpenClaw's encrypted bytes, useless without
the seed.

## Config shape (what boot writes)

`openclaw.json` holds only **non-secret wiring** — the secret token is in the
encrypted store, not here. When `LLM_AUTH_MODE=oauth`, the boot config
builder (`src/provision/render-workspace.ts`) emits:

```jsonc
{
  "auth": {
    "profiles": { "openai-codex:default": { "provider": "openai-codex", "mode": "oauth" } },
    "order":    { "openai": ["openai-codex:default"], "openai-codex": ["openai-codex:default"] }
  },
  "plugins": { "entries": { "openai": { "enabled": true }, "codex": { "enabled": true } } }
  // ...model stays "openai/<model>"; no models.providers.openai.apiKey block
}
```

This mirrors what `openclaw config` writes for a ChatGPT-OAuth setup, so a
from-scratch boot does not un-wire OAuth.

## Env vars (image)

| Var | Meaning |
| --- | --- |
| `LLM_AUTH_MODE` | `api_key` (default) or `oauth`. `oauth` emits the block above instead of an API key. |
| `OPENCLAW_AUTH_PROFILE_SECRET_KEY` | Stable per-agent seed for the auth-store encryption key. **Required** when `LLM_AUTH_MODE=oauth`. Passed straight through to the gateway child. |

The console sets both on the Railway service (the seed once, at first OAuth
opt-in, and never rotated for the life of the agent).

## Boot pipeline (implemented)

`src/index.ts` → when `LLM_AUTH_MODE=oauth`, calls
`restoreOAuthStore(env)` (`src/provision/oauth-store.ts`) **before** the
gateway starts, downloading the encrypted store from
`agent-data/orgs/{org}/agents/{uid}/config/oauth/auth-profile-store.json` and
writing the files back into the state dir. No-op on a first-ever boot.

## Minting the token on the container (implemented)

OpenClaw's `models auth` commands (`login`, `paste-token`, `setup-token`,
`add`) are **all interactive TUIs** in 2026.5.20 — they refuse a non-TTY and
ignore piped stdin. We chose to **let OpenClaw mint the token** rather than
reproduce its on-disk crypto: the shim drives OpenClaw's own
`models auth login --provider openai-codex --method oauth` under a
pseudo-terminal (util-linux `script`, added to the image), scrapes the
`auth.openai.com/oauth/authorize?…` URL, and types the operator-pasted
callback at the "Paste the redirect URL" prompt. OpenClaw owns the PKCE
exchange, the encrypted store, and refresh — correct by construction. The
tradeoff: the flow is tied to OpenClaw's prompt wording, so a major upgrade
that changes it breaks **loudly** (a timeout), not silently.
(`--method oauth` skips the interactive method-picker — method id confirmed
from the pinned bundle.)

`src/shim/oauth-session.ts` owns the PTY session (start → hold at the paste
prompt → complete). After a successful exchange the complete handler calls
`persistOAuthStore(env)` to back up the encrypted store, then restarts
**only** the openclaw child (`GatewayProcess.restart()`) — no Railway
redeploy.

> Considered but rejected: owning the PKCE exchange + writing the store
> ourselves. We extracted the exact AES-256-GCM envelope
> (`{iv,tag,ciphertext}` base64url, AAD = `${ref.id}\0${profileId}\0${provider}`,
> key = `sha256("openclaw:auth-profile-oauth:"+seed)`) — deterministic and
> dependency-free, but it reproduces an OpenClaw-internal format that can
> break **silently** on a version bump. Documented here in case the TUI path
> ever becomes untenable.

### Shim surface (port 8080, bearer-authenticated, operator/user only)

| Method + path | Behavior |
| --- | --- |
| `POST /api/v1/auth/oauth/start` | `{ provider: "openai-codex" }` → `{ url }`. Begins the flow, returns the authorize URL. |
| `POST /api/v1/auth/oauth/complete` | `{ provider, callbackUrl }` → exchanges, persists to Storage, restarts the gateway. |
| `GET  /api/v1/auth/oauth/status` | `{ mode: "api_key" \| "oauth", provider, connected }` for the console badge. |

### Still to do (console side)

- A route-handler proxy (mirror `messaging-proxy.ts` + the `interrupt`
  route) that forwards start/complete/status to the agent gateway URL.
- A "Connect with OAuth" auth source in the model switcher: show URL → paste
  callback → connected badge.
- Provisioning: set `LLM_AUTH_MODE` + generate a stable
  `OPENCLAW_AUTH_PROFILE_SECRET_KEY` on the Railway service when OAuth is
  selected.

### Remote-mode gotcha (resolved)

OpenClaw's Codex login picks its strategy from `isRemoteEnvironment()`: in a
"local" environment it **binds `127.0.0.1:1455` and waits for a browser
callback** (which succeeds in-container and then hangs forever, since the
operator's browser can't reach the container); only in a "remote" environment
does it print the URL + prompt for the pasted redirect. The shim therefore
spawns the login with `REMOTE_CONTAINERS=true` to force the remote branch.
Other triggers OpenClaw accepts: `SSH_CONNECTION`, `SSH_TTY`, `SSH_CLIENT`,
`CODESPACES`.

### Needs live-container validation

The PTY mint can't be exercised without a real container + real OpenAI
account. Validate against a live agent: the scraped authorize URL, the paste
prompt wording, and the success/failure detection in
`src/shim/oauth-session.ts` (the regexes there may need tuning to OpenClaw's
exact output).
