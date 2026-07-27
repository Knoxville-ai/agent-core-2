#!/opt/skills-venv/bin/python3
"""Knox delegated-credential exec shim for `python3`.

WHY THIS EXISTS
---------------
On a platform-brokered agent-to-agent (A2A) turn, the runtime pulls the caller's
shared credentials and must expose them to the skill's `exec` subprocess for that
one turn (see BYOA.md / the delegated-credentials design). The intended path is an
openclaw `before_tool_call` plugin that rewrites the exec tool's `env`, keyed by
`ctx.sessionKey`.

THAT PLUGIN IS THE PRIMARY PATH, and it works on the chat-completions turns too.
Verified against openclaw 2026.5.20:

  x-openclaw-session-key  (set by the shim)
    -> resolveGatewayRequestContext   (dist/http-utils, reads the header)
    -> pi-embedded-runner sandboxSessionKey
    -> catalogToolHookContext.sessionKey  (dist/selection)
    -> runBeforeToolCallHook(ctx)     (dist/tool-split, wraps EVERY tool)
    -> plugin injects params.env
    -> execSchema.env                 (dist/bash-tools.schemas)
    -> subprocess environment

An earlier version of this comment claimed the embedded run does not fire
`before_tool_call`. That is not true of 2026.5.20, and the claim is what forced
delegated work to run one turn at a time. If you are debugging a credential
problem, re-verify the chain above before assuming the plugin is not firing.

THIS SHIM IS NOW A FALLBACK, for the case where the plugin genuinely did not run
(an older openclaw, a tool profile that strips plugins, an exec host that bypasses
the wrapper). It is strictly less capable than the plugin: openclaw exposes no
session id to the exec subprocess, so the shim cannot ask "my session's
credentials" — only "the single live delegated turn" — and must return nothing
when several overlap. Anything relying on the shim is therefore limited to one
delegated turn at a time; anything on the plugin path is not.

WHAT THIS DOES
--------------
It is placed FIRST on the exec tool's PATH (via `tools.exec.pathPrepend`), so a
skill's bare `python3 ...` resolves here. It then, strictly best-effort:

  0. checks for the plugin's injection marker (KNOX_DELEGATED_CREDS_INJECTED). If
     it is set, the parallel-safe path already ran and this shim does nothing but
     re-exec — no loopback call, no single-turn restriction.
  1. otherwise pulls the current delegated turn's credentials from the shim's
     loopback route using the gateway token already present in the exec env, and
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
  * Per-turn isolation on the FALLBACK path is enforced shim-side (`currentSingle`
    returns creds only when exactly one delegated turn is live). On the primary
    (plugin) path isolation is by session key, so concurrency is unrestricted.
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


# Set by the before_tool_call plugin when it has already injected this call's
# credentials (see openclaw-plugins/delegated-credentials/inject.js). Its presence
# means the parallel-safe path ran and this shim must not second-guess it.
_PLUGIN_MARKER = "KNOX_DELEGATED_CREDS_INJECTED"


def _augment_env():
    """Best-effort: fetch this turn's delegated creds and export them. Silent on
    any failure — the caller's env is simply left as-is."""
    if os.environ.get(_PLUGIN_MARKER):
        # The plugin already injected, keyed by session. Doing our own
        # single-turn lookup here could only ever be worse: it would add a
        # loopback round-trip and, with several delegated turns live, return
        # nothing at all. Stand down.
        return
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
