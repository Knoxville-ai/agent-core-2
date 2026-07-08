# syntax=docker/dockerfile:1.7
#
# Knoxville agent-core (openclaw vessel).
#
# Single-stage Node 24 image. The container runs one process group:
#   1. The shim (this repo's compiled TS) listens on :8080 and exposes the
#      HTTP/SSE contract the knoxville-ai-console already speaks.
#   2. The shim spawns `openclaw gateway` as a child process and proxies
#      conversation turns to it over the gateway WebSocket protocol.
#
# All per-agent configuration is delivered via env vars + Supabase Storage
# at boot — there is nothing role-specific in this image.

FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    HOME=/home/agent \
    OPENCLAW_STATE_DIR=/home/agent/.openclaw \
    AGENT_HTTP_PORT=8080 \
    OPENCLAW_GATEWAY_PORT=18789

# bsdextrautils provides util-linux `script`, which the shim uses to
# allocate a PTY when driving OpenClaw's interactive `models auth login`
# (model-provider OAuth). See src/shim/oauth-session.ts.
#
# gosu lets the entrypoint start as root (to chown the Railway volume that
# mounts root-owned + empty over OPENCLAW_STATE_DIR) and then drop to the
# agent uid before exec'ing the Node process. See entrypoint.sh.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini bsdextrautils gosu \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 agent \
 && useradd  --system --uid 1001 --gid 1001 --create-home --home-dir /home/agent --shell /bin/bash agent \
 && mkdir -p /app /home/agent/.openclaw/workspace/skills \
 && chown -R agent:agent /app /home/agent

WORKDIR /app

# Install deps first (better layer caching).
COPY --chown=agent:agent package.json package-lock.json* ./
RUN npm install --omit=dev=false --no-audit --no-fund

# The shim spawns `openclaw` by bare name; child_process.spawn does not
# prepend node_modules/.bin to PATH the way `npm run` does, so the CLI
# must be globally installed for the gateway child to launch.
RUN npm install -g --no-audit --no-fund openclaw@2026.5.20

# Build the shim.
COPY --chown=agent:agent tsconfig.json ./
COPY --chown=agent:agent src ./src
RUN npm run build && npm prune --omit=dev

# --- Python toolchain for skills that declare `install.uv` -------------------
# node:24-bookworm-slim ships no Python, so skills whose openclaw frontmatter
# declares `requires.bins: [python3]` + `install.uv: [...]` (e.g.
# drivethru-graphic-artist: Pillow/rembg/onnxruntime, or drivethru-odoo: mcp)
# cannot run in the base image. Provide a self-contained Python runtime here:
#
#   * apt `python3` + `python3-venv` — the interpreter and venv module.
#   * A dedicated venv at /opt/skills-venv holding `uv` plus a WARM CACHE of the
#     heaviest skill libraries, pre-installed at build time so boot is fast and
#     works even when the network policy blocks outbound PyPI.
#
# IMPORTANT: this build-time `uv pip install` is only a cache/offline fallback —
# it is NOT how a skill's deps actually get provisioned. Skills are synced at
# RUNTIME (workspace/skills/ is wiped + reinstalled every boot, and the live
# /skills/install route adds more), so the authoritative, generalized installer
# is the boot/live step in src/skills/deps.ts (`provisionSkillDeps`): it reads
# each installed SKILL.md's `metadata.openclaw.install.uv` and `uv pip install`s
# it into THIS venv (the interpreter bare `python3` resolves to). That means a
# newly-installed skill's deps are covered automatically without editing this
# list. The packages below just pre-warm the heavy graphic-artist deps so that
# common skill doesn't pay a ~1 GB download on its first boot; drop them if you
# prefer a slimmer image and always-on PyPI access.
#
# The venv lives in /opt (outside /home/agent). It is chowned to the agent uid
# below (with /opt/pw-browsers) so the runtime `provisionSkillDeps` step can
# write new packages into it as the unprivileged agent. Prepending its bin to
# PATH (below) makes bare `python3` / `uv` resolve here, so the skill's
# `python3 scripts/compose_mockup.py ...` finds the libraries.
#
# NOTE: this adds ~1 GB to the image (onnxruntime + scipy + scikit-image +
# opencv + numba pull a lot of transitive weight).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/skills-venv \
 && /opt/skills-venv/bin/pip install --no-cache-dir --upgrade pip uv \
 && /opt/skills-venv/bin/uv pip install --no-cache \
      --python /opt/skills-venv/bin/python \
      'Pillow>=10.3,<12' 'rembg>=2.0.56,<3' 'onnxruntime>=1.18,<2'

# rembg downloads its ~170 MB u2net model on first use. Point its cache at the
# Railway persistence volume (OPENCLAW_STATE_DIR) so the one-time download
# survives restarts/redeploys instead of re-fetching into an ephemeral $HOME.
# entrypoint.sh creates + chowns this dir to the agent uid before dropping privs.
ENV U2NET_HOME=/home/agent/.openclaw/u2net

# --- Headless Chromium for Playwright-based skills ---------------------------
# For a browser skill (`install.uv: [playwright...]`), the runtime step in
# src/skills/deps.ts installs the `playwright` Python package into the venv and
# runs `python3 -m playwright install chromium` (idempotent — it reports
# "already installed" against the build pre-bake below). What that step CANNOT
# do is install the OS-level shared libraries Chromium needs (libglib-2.0.so.0,
# libnss3, ...): it runs unprivileged (agent uid). Without them a skill's
# `chromium.launch()` dies with "error while loading shared libraries:
# libglib-2.0.so.0: cannot open shared object file". Those system packages must
# be baked into the image, as root — which is what this block does.
#
# We add `playwright` to the skills-venv purely to reach its two build-time
# helpers:
#   * `playwright install-deps chromium` apt-installs the canonical Chromium
#     dependency set (system libs + rendering fonts like fonts-liberation /
#     fonts-unifont) that the Playwright project maintains per-distro, so we
#     track upstream instead of hand-pinning a package list that silently drifts
#     as Chromium's needs change.
#   * `playwright install chromium` pre-bakes the ~150 MB browser build into a
#     shared PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers) so the first skill run
#     doesn't pay the download — and still works under network policies that
#     block the browser CDN at boot.
#
# The gateway spawns openclaw (and thus skills) with the container env (see
# src/openclaw/gateway-process.ts), so PLAYWRIGHT_BROWSERS_PATH below points a
# skill's own runtime Playwright at this baked build instead of the default
# $HOME/.cache/ms-playwright. /opt/pw-browsers is chowned to the agent uid so
# the build is usable without root; keeping it agent-writable also lets the
# agent download a matching build into the same dir in the rare case a skill
# installs a newer Playwright whose expected Chromium revision differs from the
# baked one (the system libs installed above stay valid across Chromium
# revisions, so that fallback never needs root).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN apt-get update \
 && /opt/skills-venv/bin/pip install --no-cache-dir 'playwright>=1.40' \
 && /opt/skills-venv/bin/python -m playwright install-deps chromium \
 && /opt/skills-venv/bin/python -m playwright install chromium \
 && rm -rf /var/lib/apt/lists/* \
 && chown -R agent:agent /opt/pw-browsers /opt/skills-venv

# --- Ollama binary for in-container LOCAL models -----------------------------
# Bake the `ollama` CLI/server so agents provisioned with LLM_PROVIDER=ollama
# can run a small model inside the container (no external API bill). We install
# ONLY the binary + its bundled CPU runner here — NO model weights. The multi-GB
# weights are pulled at RUNTIME, and ONLY for an agent actually set to a local
# model (see src/openclaw/ollama-process.ts → maybeStartOllama). An
# OpenAI/Anthropic/external-endpoint agent never starts ollama and never
# downloads a weight, so it pays only this one-time image cost.
#
# Uses Ollama's documented manual-install tarball (amd64 — Railway is amd64),
# extracted into /usr (→ /usr/bin/ollama + /usr/lib/ollama). Set the
# INSTALL_OLLAMA build arg to "false" to build a slimmer image with no local
# model support. OLLAMA_VERSION pins the release for reproducibility.
ARG INSTALL_OLLAMA=true
ARG OLLAMA_VERSION=0.5.7
RUN if [ "$INSTALL_OLLAMA" = "true" ]; then \
      set -eu; \
      arch="$(dpkg --print-architecture)"; \
      case "$arch" in \
        amd64) asset="ollama-linux-amd64.tgz" ;; \
        arm64) asset="ollama-linux-arm64.tgz" ;; \
        *) echo "unsupported arch for ollama: $arch" >&2; exit 1 ;; \
      esac; \
      curl -fsSL "https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/${asset}" -o /tmp/ollama.tgz; \
      tar -C /usr -xzf /tmp/ollama.tgz; \
      rm -f /tmp/ollama.tgz; \
      ollama --version >/dev/null 2>&1 || true; \
    fi

# Drop runtime entrypoint last so iteration on it doesn't bust the npm layer.
COPY --chown=agent:agent entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Per-user npm prefix so the agent can run `npm i -g <skill>` (clawhub
# installs, etc.) at runtime without root. The openclaw CLI itself was
# installed globally above (as root) and stays reachable via /usr/local/bin.
# Set this after all build-time `npm install -g` calls so they continue
# to land in /usr/local — only runtime installs use the user prefix.
ENV NPM_CONFIG_PREFIX=/home/agent/.npm-global \
    PATH=/home/agent/.npm-global/bin:/opt/skills-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Build-time npm ran as root with HOME=/home/agent, so the cache + any
# npm-touched dirs under /home/agent are root-owned. Reset ownership to
# the agent uid (and create the new global prefix dir while we're here)
# before dropping privileges, otherwise runtime `npm` hits EPERM.
RUN mkdir -p /home/agent/.npm-global \
 && chown -R agent:agent /home/agent

# NOTE: we deliberately do NOT `USER agent` here. Railway mounts the
# persistence volume root-owned + empty over OPENCLAW_STATE_DIR, and a
# non-root process can neither write to nor chown it. The container starts
# as root so entrypoint.sh can chown the mount, then drops to the agent uid
# via `gosu` before exec'ing Node. tini (PID 1) still reaps the openclaw
# grandchild on SIGTERM regardless of which uid runs the Node process.
EXPOSE 8080

# Tini reaps the openclaw child cleanly when Railway sends SIGTERM.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
