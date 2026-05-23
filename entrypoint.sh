#!/usr/bin/env bash
# Entrypoint for the agent-core (openclaw vessel) container.
#
# All bootstrapping happens inside the Node process so it can share types,
# logging, and the Supabase client with the shim. This script exists only to
# normalize a couple of env defaults and exec the Node entrypoint as PID 1's
# child under tini.

set -euo pipefail

export HOME="${HOME:-/home/agent}"
export OPENCLAW_HOME="${OPENCLAW_HOME:-${HOME}/.openclaw}"
mkdir -p "${OPENCLAW_HOME}/workspace/skills"

exec node --enable-source-maps /app/dist/index.js
