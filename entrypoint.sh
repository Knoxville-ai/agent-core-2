#!/usr/bin/env bash
# Entrypoint for the agent-core (openclaw vessel) container.
#
# All bootstrapping happens inside the Node process so it can share types,
# logging, and the Supabase client with the shim. This script exists only to
# normalize a couple of env defaults and exec the Node entrypoint as PID 1's
# child under tini.

set -euo pipefail

# OPENCLAW_STATE_DIR is where openclaw.json + the workspace live.
# Distinct from openclaw's own OPENCLAW_HOME (a user-home equivalent
# that openclaw appends `.openclaw` to). Defaults in the Dockerfile.
export HOME="${HOME:-/home/agent}"
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-${HOME}/.openclaw}"
mkdir -p "${OPENCLAW_STATE_DIR}/workspace/skills"

exec node --enable-source-maps /app/dist/index.js
