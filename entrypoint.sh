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

# Give openclaw a private, agent-owned TMPDIR for the whole process tree.
# Otherwise openclaw's temp-dir fallback targets the shared, predictable
# /tmp/openclaw-<uid> path and crashes with "Unsafe fallback OpenClaw temp
# dir" the moment that path is left around by another uid (or with loose
# perms). The Node spawn sites set this too (see src/openclaw/temp-dir.ts);
# exporting it here covers any openclaw command the agent runs directly.
export TMPDIR="${OPENCLAW_STATE_DIR}/tmp"
mkdir -p "${TMPDIR}"
chmod 700 "${TMPDIR}"

exec node --enable-source-maps /app/dist/index.js
