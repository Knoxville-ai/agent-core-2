#!/opt/skills-venv/bin/python3
"""Knox delegated-credential exec shim for `python3`.

WHY THIS EXISTS
---------------
On a platform-brokered agent-to-agent (A2A) turn, the runtime pulls the caller's
shared credentials and must expose them to the skill's `exec` subprocess for that
one turn (see BYOA.md / the delegated-credentials design). The intended path was
an openclaw `before_tool_call` plugin that rewrites the exec tool's `env`.

That plugin works on the agent's native/heartbeat runs, but NOT on the turns that
matter: the shim proxies delegated turns through openclaw's OpenAI-compatible
`/v1/chat/completions` endpoint, whose embedded run does NOT fire `before_tool_call`
hooks. openclaw also (a) rebuilds the exec PATH so only `tools.exec.pathPrepend`
survives, (b) inherits the gateway's fixed process env for exec (the shim can't
mutate it per-turn), (c) offers no per-request env passthrough, and (d) exposes no
session id to the exec subprocess. So there is no in-openclaw hook that can inject
per-turn env on the delegated path.

WHAT THIS DOES
--------------
It is placed FIRST on the exec tool's PATH (via `tools.exec.pathPrepend`), so a
skill's bare `python3 ...` resolves here. It then, strictly best-effort:

  1. pulls the current delegated turn's credentials from the shim's loopback route
     using the gateway token already present in the exec env, and
  2. exports each `ENV_KEY=value` into the environment (never overwriting a value
     the caller already set), then
  3. re-execs the REAL interpreter (`/opt/skills-venv/bin/python3`) with the
     original arguments.

GUARANTEES
----------
  * FAIL-OPEN: `python3` ALWAYS runs. Any error fetching/parsing credentials is
    swallowed and the real interpreter is exec'd with the env unchanged.
  * NEVER logs the secret VALUES. It logs only the injected key NAMES (to stderr),
    matching the names-only rule the rest of the runtime follows.
  * Per-turn isolation is enforced on the SHIM side (`currentSingle` returns creds
    only when exactly one delegated turn is live; these agents serialize turns).
"""

import os
import sys

# The real interpreter the skills venv provides (holds `requests` etc.). Absolute
# so this shim never re-resolves `python3` through PATH (no recursion into itself).
REAL_PYTHON = "/opt/skills-venv/bin/python3"

_FETCH_TIMEOUT_S = 2.0


def _valid_env_key(key):
    if not key:
        return False
    if not (key[0].isalpha() or key[0] == "_"):
        return False
    return all(ch.isalnum() or ch == "_" for ch in key)


def _augment_env():
    """Best-effort: fetch this turn's delegated creds and export them. Silent on
    any failure — the caller's env is simply left as-is."""
    token = os.environ.get("OPENCLAW_GATEWAY_TOKEN")
    if not token:
        return
    port = os.environ.get("AGENT_HTTP_PORT") or "8080"

    import json
    import urllib.request

    url = "http://127.0.0.1:%s/internal/delegated-credentials" % port
    req = urllib.request.Request(url, headers={"Authorization": "Bearer %s" % token})
    with urllib.request.urlopen(req, timeout=_FETCH_TIMEOUT_S) as resp:
        body = json.loads(resp.read().decode("utf-8"))

    creds = body.get("credentials") if isinstance(body, dict) else None
    if not isinstance(creds, dict):
        return

    injected = []
    for key, value in creds.items():
        if not (isinstance(key, str) and isinstance(value, str)):
            continue
        if not _valid_env_key(key):
            continue
        if key in os.environ:  # never clobber an explicitly-set value
            continue
        os.environ[key] = value
        injected.append(key)

    if injected:
        # Names only — never the values.
        sys.stderr.write(
            "[knox-exec-shim] injected %d delegated credential(s): [%s]\n"
            % (len(injected), ", ".join(sorted(injected)))
        )


def main():
    try:
        _augment_env()
    except Exception:
        # Fail open: never let a credential-fetch problem block python execution.
        pass
    # Replace this process with the real interpreter, preserving argv.
    os.execv(REAL_PYTHON, [REAL_PYTHON] + sys.argv[1:])


if __name__ == "__main__":
    main()
