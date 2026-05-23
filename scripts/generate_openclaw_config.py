#!/usr/bin/env python3
"""Generate OpenClaw config files from environment variables.

Creates:
  ~/.openclaw/openclaw.json         — main config
  ~/.openclaw/credentials/telegram-default-allowFrom.json — chat allowlist
  ~/.openclaw/credentials/telegram-pairing.json           — pairing state

LLM configuration (set by the console UX on the Railway container):
  LLM_PROVIDER  — provider name: openai, anthropic, ollama, google, groq, …
  LLM_MODEL     — model id:     gpt-4o-mini, claude-sonnet-4-6, qwen3:4b, …
  LLM_API_KEY   — customer BYO key (optional — overrides the platform default)

The platform injects OPENAI_API_KEY and ANTHROPIC_API_KEY as defaults.
When LLM_API_KEY is set it takes precedence for the chosen provider.
When LLM_PROVIDER=ollama no API key is needed (local model).

Messaging (console ↔ gateway bridge):
  MESSAGING_ENABLED        — "true" turns on gateway.http.endpoints.chatCompletions
  OPENCLAW_GATEWAY_TOKEN   — Bearer token used by the Flask proxy when calling
                              http://127.0.0.1:18789/v1/chat/completions
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


# Sensible default model per provider.
_DEFAULT_MODELS: dict[str, str] = {
    "openai": "gpt-4o-mini",
    "anthropic": "claude-sonnet-4-6",
    "google": "gemini-2.0-flash",
    "groq": "llama-3.3-70b-versatile",
    "mistral": "mistral-small-latest",
    # ollama falls through to OLLAMA_MODEL / qwen3:1.7b
}


def _resolve_llm_config() -> tuple[str, str]:
    """Return (provider, model) from environment."""
    provider = os.getenv("LLM_PROVIDER", "openai").strip().lower()
    model = os.getenv("LLM_MODEL", "").strip()

    if not model:
        if provider == "ollama":
            model = os.getenv("OLLAMA_MODEL", "qwen3:1.7b")
        else:
            model = _DEFAULT_MODELS.get(provider, "gpt-4o-mini")

    return provider, model


def _bool(val: str | None, default: bool = False) -> bool:
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes")


def main() -> None:
    state_dir = Path(os.getenv("OPENCLAW_STATE_DIR", os.path.expanduser("~/.openclaw")))
    creds_dir = state_dir / "credentials"
    creds_dir.mkdir(parents=True, exist_ok=True)

    # Agent workspace lives under ~/.openclaw/workspace so that OpenClaw's
    # bundled hooks (boot-md, session-memory) and the system-prompt
    # bootstrap-file injector (which reads SOUL.md/IDENTITY.md/BOOT.md
    # alongside AGENTS.md) find the role files that bootstrap.py wrote
    # there. This MUST agree with bootstrap.py / migrations.py /
    # agent_boot.py — they share the same env var + default. Override
    # via OPENCLAW_WORKSPACE_DIR if you point the workspace at a
    # persistent volume, but be sure bootstrap writes to the same place.
    workspace_dir = Path(os.getenv("OPENCLAW_WORKSPACE_DIR", "/root/.openclaw/workspace"))

    telegram_token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    allowed_chat_id = os.getenv("TELEGRAM_ALLOWED_CHAT_ID", "")
    gateway_port = int(os.getenv("OPENCLAW_GATEWAY_PORT", "18789"))
    messaging_enabled = _bool(os.getenv("MESSAGING_ENABLED"), False)

    provider, model = _resolve_llm_config()
    qualified_model = f"{provider}/{model}"
    profile_name = f"{provider}:default"
    is_ollama = provider == "ollama"

    print(f"OpenClaw LLM: provider={provider}  model={qualified_model}", file=sys.stderr)
    if messaging_enabled:
        print("OpenClaw: chatCompletions HTTP endpoint enabled", file=sys.stderr)

    # ── Auth profile ───────────────────────────────────
    if is_ollama:
        auth_profile = {"provider": "ollama", "mode": "none"}
    else:
        auth_profile = {"provider": provider, "mode": "api_key"}

    # ── Per-model overrides (e.g. Ollama base URL) ──────
    model_entry: dict = {}
    if is_ollama:
        ollama_base = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
        model_entry["api_base"] = ollama_base

    # ── Gateway block ────────────────────────────────────
    gateway: dict = {
        "port": gateway_port,
        "mode": "local",
        "bind": "lan",
        "auth": {
            "mode": "token",
            "token": os.getenv("OPENCLAW_GATEWAY_TOKEN", "container-auto-token"),
        },
    }
    if messaging_enabled:
        # Enable the OpenAI-compatible REST endpoint. The Flask proxy in
        # this container is the only intended caller; port 18789 is not
        # exposed outside the Railway service.
        gateway["http"] = {
            "endpoints": {
                "chatCompletions": {"enabled": True},
            }
        }

    # ── Main config ───────────────────────────────────────
    config = {
        "meta": {
            "lastTouchedVersion": "2026.4.8",
        },
        "auth": {
            "profiles": {
                profile_name: auth_profile,
            }
        },
        "agents": {
            "defaults": {
                "model": {
                    "primary": qualified_model,
                },
                "models": {
                    qualified_model: model_entry,
                },
                "workspace": str(workspace_dir),
            }
        },
        "tools": {
            "profile": "coding",
        },
        "commands": {
            "native": "auto",
            "nativeSkills": "auto",
            "restart": True,
            "ownerDisplay": "raw",
        },
        "session": {
            "dmScope": "per-channel-peer",
        },
        "hooks": {
            "internal": {
                "enabled": True,
                "entries": {
                    "boot-md": {"enabled": True},
                    "command-logger": {"enabled": True},
                    "session-memory": {"enabled": True},
                }
            }
        },
        "channels": {
            "telegram": {
                "enabled": bool(telegram_token),
                "dmPolicy": "pairing",
                "botToken": telegram_token,
                "groupPolicy": "allowlist",
                "streaming": {
                    "mode": "partial",
                },
            }
        },
        "gateway": gateway,
        "plugins": {
            "entries": {
                "telegram": {"enabled": bool(telegram_token)},
            }
        },
    }

    config_path = state_dir / "openclaw.json"
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    print(f"OpenClaw config written to {config_path}", file=sys.stderr)

    # ── Telegram allowlist ──────────────────────────────
    if allowed_chat_id:
        allow_from = {
            "version": 1,
            "allowFrom": [allowed_chat_id],
        }
        allow_path = creds_dir / "telegram-default-allowFrom.json"
        allow_path.write_text(json.dumps(allow_from, indent=2) + "\n")
        print(f"Telegram allowlist written to {allow_path}", file=sys.stderr)

    # ── Telegram pairing state ────────────────────────────
    pairing = {
        "version": 1,
        "requests": [],
    }
    pairing_path = creds_dir / "telegram-pairing.json"
    pairing_path.write_text(json.dumps(pairing, indent=2) + "\n")
    print(f"Telegram pairing written to {pairing_path}", file=sys.stderr)

    # ── Workspace dir ───────────────────────────────────
    workspace_dir.mkdir(parents=True, exist_ok=True)


if __name__ == "__main__":
    main()
