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

## The one open piece: minting the token on the container

The console → container control channel and UI are straightforward (mirror
`messaging-proxy.ts` + the `interrupt` route; add an "auth source" to the
model switcher). The hard part is **how the shim mints the credential**,
because OpenClaw's `models auth` commands (`login`, `paste-token`,
`setup-token`, `add`) are **all interactive TUIs** in 2026.5.20 — they refuse
a non-TTY and ignore piped stdin. Two viable strategies (decision pending):

- **A. PTY-drive OpenClaw's own `models auth login --provider openai-codex`.**
  Spawn it under a pseudo-TTY, scrape the printed authorize URL, and type the
  pasted callback at the "Paste the redirect URL to continue" prompt.
  OpenClaw writes its own encrypted store + handles refresh (correct by
  construction). Cost: needs a PTY in the slim image — `node-pty` has **no
  Linux prebuild** (would need a build toolchain), or use `script`
  (util-linux) + ANSI-stripping; and TUI scraping is brittle across upgrades.

- **B. Own the PKCE exchange in the shim and write the store directly.**
  Deterministic, no TUI, no native deps; we have the exact AES-256-GCM
  envelope (`{iv,tag,ciphertext}` base64url, AAD = `${ref.id}\0${profileId}\0${provider}`).
  Cost: reproduces an OpenClaw-internal on-disk format that can break
  silently on an OpenClaw version bump.

Whichever is chosen, the post-mint steps are the same: `persistOAuthStore(env)`
to back up the encrypted store, then restart **only** the openclaw child
(`GatewayProcess.stop()`/`start()`) — no Railway redeploy.

### Planned shim surface (port 8080, bearer-authenticated like the rest)

| Method + path | Behavior |
| --- | --- |
| `POST /api/v1/auth/oauth/start` | `{ provider: "openai-codex" }` → `{ url }`. Begins the flow, returns the authorize URL. |
| `POST /api/v1/auth/oauth/complete` | `{ provider, callbackUrl }` → exchanges, stores, persists to Storage, restarts the gateway. |
| `GET  /api/v1/auth/status` | `{ mode: "api_key" \| "oauth", connected: bool }` for the console badge. |
