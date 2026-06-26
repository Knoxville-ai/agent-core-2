#!/usr/bin/env bash
# Entrypoint for the agent-core (openclaw vessel) container.
#
# Runs as ROOT under tini so it can take ownership of the Railway persistence
# volume, then drops to the unprivileged `agent` uid (via gosu) before exec'ing
# the Node process. All real bootstrapping happens inside the Node process so it
# can share types, logging, and the Supabase client with the shim; this script
# only normalizes a couple of env defaults, prepares the volume, and drops privs.

set -euo pipefail

# OPENCLAW_STATE_DIR is where openclaw.json + the workspace live, and is also
# where openclaw itself writes its durable state (agents/<id>/sessions/,
# memory/<id>.sqlite, credentials/). Distinct from openclaw's own OPENCLAW_HOME
# (a user-home equivalent that openclaw appends `.openclaw` to). Defaults in the
# Dockerfile. On Railway this whole dir is a mounted volume, so it survives
# restarts/redeploys.
export HOME="${HOME:-/home/agent}"
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-${HOME}/.openclaw}"

# Railway mounts the volume root-owned + empty. Take ownership so the agent uid
# can write to it. A recursive chown over a populated state dir (large session
# transcript trees) is slow, so only do the full recursive pass once — on the
# first boot after the volume is attached — and a cheap top-level chown on every
# subsequent boot (subtrees are already agent-owned because the agent created
# them). The sentinel itself lives on the volume, so it persists across restarts.
INIT_SENTINEL="${OPENCLAW_STATE_DIR}/.knox-volume-initialized"
mkdir -p "${OPENCLAW_STATE_DIR}"
if [ ! -e "${INIT_SENTINEL}" ]; then
  chown -R agent:agent "${OPENCLAW_STATE_DIR}"
  touch "${INIT_SENTINEL}"
  chown agent:agent "${INIT_SENTINEL}"
else
  chown agent:agent "${OPENCLAW_STATE_DIR}"
fi

# Workspace skills dir is wiped + reinstalled from the bundle every boot, but
# create it up front so the path exists.
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

# These dirs were just (re)created as root; hand them to the agent. Cheap —
# they are empty or tiny relative to the durable session/memory trees above.
chown -R agent:agent "${OPENCLAW_STATE_DIR}/workspace/skills" "${TMPDIR}"

# Drop privileges to the agent uid and hand off to Node. exec keeps tini as the
# parent (PID 1) so SIGTERM still reaches Node and the openclaw grandchild.
exec gosu agent:agent node --enable-source-maps /app/dist/index.js
