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

# Build provenance so a running container can report exactly which commit
# it was built from (logged at boot + surfaced on /healthz). The docker
# workflow passes --build-arg BUILD_REF=<git sha>; defaults to "dev" locally.
ARG BUILD_REF=dev
ENV BUILD_REF=${BUILD_REF}

# bsdextrautils provides util-linux `script`, which the shim uses to
# allocate a PTY when driving OpenClaw's interactive `models auth login`
# (model-provider OAuth). See src/shim/oauth-session.ts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini bsdextrautils \
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

# Drop runtime entrypoint last so iteration on it doesn't bust the npm layer.
COPY --chown=agent:agent entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Per-user npm prefix so the agent can run `npm i -g <skill>` (clawhub
# installs, etc.) at runtime without root. The openclaw CLI itself was
# installed globally above (as root) and stays reachable via /usr/local/bin.
# Set this after all build-time `npm install -g` calls so they continue
# to land in /usr/local — only runtime installs use the user prefix.
ENV NPM_CONFIG_PREFIX=/home/agent/.npm-global \
    PATH=/home/agent/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Build-time npm ran as root with HOME=/home/agent, so the cache + any
# npm-touched dirs under /home/agent are root-owned. Reset ownership to
# the agent uid (and create the new global prefix dir while we're here)
# before dropping privileges, otherwise runtime `npm` hits EPERM.
RUN mkdir -p /home/agent/.npm-global \
 && chown -R agent:agent /home/agent

USER agent
EXPOSE 8080

# Tini reaps the openclaw child cleanly when Railway sends SIGTERM.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
