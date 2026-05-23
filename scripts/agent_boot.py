#!/usr/bin/env python3
"""Agent boot sequence — runs before supervisord starts.

1. Derive AGENT_UID from TELEGRAM_BOT_TOKEN (or explicit env var)
2. Resolve AGENT_ORG (default: 'default')
3. Connect to Supabase Storage (and the roles catalog sitting next to it)
4. Materialize the configured AGENT_ROLE from the catalog into /app/roles/{slug}/
5. Migrate from legacy un-scoped layout if needed
6. If returning agent: pull state, then run role migration if needed
7. If new agent: bootstrap from role defaults
8. Install Class 2 SME skills from /srv/sme/skills/ into the OpenClaw workspace
9. Write AGENT_UID and AGENT_ORG to /data for other scripts
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, "/app")

from app.agent.uid import derive_agent_uid
from app.agent.manifest import AgentManifest
from app.agent.bootstrap import (
    bootstrap_agent,
    ensure_role_materialized,
    install_image_skills_to_workspace,
)
from app.agent.migrations import (
    get_source_version,
    needs_migration,
    run_migration,
)
from app.agent.paths import (
    agent_root,
    legacy_agent_root,
    legacy_manifest_path,
    manifest_path,
)
from app.agent.roles_catalog import RolesCatalog
from app.agent.sync import pull_agent_state
from app.storage.supabase_storage import SupabaseStorage

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("agent_boot")


def main() -> None:
    # ── Derive UID ──────────────────────────────────────
    try:
        uid = derive_agent_uid()
    except RuntimeError as e:
        logger.critical("UID derivation failed: %s", e)
        sys.exit(1)

    # ── Resolve org ─────────────────────────────────────
    org_id = os.getenv("AGENT_ORG", "default").strip() or "default"

    logger.info("Agent identity: org=%s uid=%s", org_id, uid)

    # ── Get role slug ───────────────────────────────────
    role = os.getenv("AGENT_ROLE", "").strip()
    if not role:
        logger.critical("AGENT_ROLE env var is required")
        sys.exit(1)

    _ensure_skills_dir()

    # ── Connect to Supabase ─────────────────────────────
    supabase_url = os.getenv("SUPABASE_URL", "").strip()
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()

    if not supabase_url or not supabase_key:
        logger.warning(
            "Supabase not configured — running in local-only mode "
            "(no persistence, roles catalog unavailable)"
        )
        try:
            ensure_role_materialized(role)
        except RuntimeError as e:
            logger.critical("%s", e)
            sys.exit(1)
        source_version = get_source_version(role)
        logger.info("Agent role: %s (source version: %d)", role, source_version)
        _bootstrap_local_only(role)
        install_image_skills_to_workspace()
        _write_identity_files(uid, org_id)
        return

    storage = SupabaseStorage(supabase_url, supabase_key)
    catalog = RolesCatalog(supabase_url, supabase_key, storage)

    # ── Materialize role from catalog (or fall back to baked-in) ──
    try:
        ensure_role_materialized(role, storage=storage, catalog=catalog)
    except RuntimeError as e:
        logger.critical("%s", e)
        sys.exit(1)

    source_version = get_source_version(role)
    logger.info("Agent role: %s (source version: %d)", role, source_version)

    # ── Legacy migration: move un-scoped files to org layout ──
    _migrate_from_legacy_layout(storage, org_id, uid)

    # ── Check if agent exists at the new (org-scoped) path ──
    new_manifest_data = storage.download_text(manifest_path(org_id, uid))

    if new_manifest_data:
        # ── Returning agent ─────────────────────────────
        logger.info("Returning agent detected — pulling state from Supabase")
        manifest = AgentManifest.from_json(new_manifest_data)

        # Force org_id to current value (in case env changed)
        manifest.org_id = org_id

        logger.info(
            "Agent created=%s last_boot=%s role=%s bootstrap_version=%d",
            manifest.created_at,
            manifest.last_boot,
            manifest.role,
            manifest.bootstrap_version,
        )

        pull_agent_state(storage, org_id, uid)

        if needs_migration(manifest, role):
            logger.info(
                "Migration needed: %d → %d",
                manifest.bootstrap_version,
                source_version,
            )
            try:
                manifest = run_migration(storage, org_id, uid, manifest, role)
            except Exception:
                logger.exception("Migration failed — agent will continue with old files")
        else:
            logger.info("No migration needed (already at version %d)", source_version)
            manifest.last_boot = AgentManifest(agent_uid=uid, role=role).last_boot
            storage.upload(manifest_path(org_id, uid), manifest.to_json())

    else:
        logger.info("New agent — bootstrapping from role=%s", role)
        bootstrap_agent(storage, org_id, uid, role)

    # ── Install image-shipped skills into the workspace ──
    # Runs after both branches so a redeploy of an SME image always
    # refreshes the installed skill content. Self-skips for Class 1.
    install_image_skills_to_workspace()

    _write_identity_files(uid, org_id)
    logger.info("Boot sequence complete — agent %s ready", uid)


def _migrate_from_legacy_layout(storage: SupabaseStorage, org_id: str, uid: str) -> None:
    """One-time migration: move files from agents/{uid}/ to orgs/{org_id}/agents/{uid}/."""
    # Skip if there's no legacy manifest
    legacy_manifest = storage.download_text(legacy_manifest_path(uid))
    if legacy_manifest is None:
        return

    # Skip if the new path already has data (already migrated)
    new_manifest = storage.download_text(manifest_path(org_id, uid))
    if new_manifest is not None:
        logger.info("Both legacy and new manifest exist — skipping legacy migration")
        return

    logger.info("Legacy layout detected — migrating agent %s into org %s", uid, org_id)

    legacy_root = legacy_agent_root(uid)
    new_root = agent_root(org_id, uid)

    # Known files to move
    known_files = [
        "manifest.json",
        "memory/system_prompt.md",
        "memory/identity.md",
        "memory/boot.md",
        "memory/playbook.md",
        "config/policies.json",
        "config/policy_schema.json",
        "state/state.json",
        "logs/actions.jsonl",
    ]

    moved = 0
    for sub in known_files:
        data = storage.download(f"{legacy_root}/{sub}")
        if data is not None:
            storage.upload(f"{new_root}/{sub}", data)
            moved += 1

    # Also move any date-stamped log files
    try:
        log_files = storage.list_objects(f"{legacy_root}/logs")
        for lp in log_files:
            filename = lp.rsplit("/", 1)[-1]
            data = storage.download(lp)
            if data is not None:
                storage.upload(f"{new_root}/logs/{filename}", data)
                moved += 1
    except Exception:
        logger.exception("Failed to move legacy logs")

    # Stamp org_id into the manifest at the new path
    try:
        new_mf_raw = storage.download_text(manifest_path(org_id, uid))
        if new_mf_raw:
            mf = AgentManifest.from_json(new_mf_raw)
            mf.org_id = org_id
            storage.upload(manifest_path(org_id, uid), mf.to_json())
    except Exception:
        logger.exception("Failed to stamp org_id into migrated manifest")

    logger.info("Legacy migration complete — moved %d files", moved)


def _bootstrap_local_only(role: str) -> None:
    """Bootstrap without Supabase — copy role defaults to local filesystem."""
    from app.agent.bootstrap import ROLES_DIR

    logger.info("Local-only bootstrap from role=%s", role)
    role_dir = ROLES_DIR / role
    workspace = Path(os.getenv("OPENCLAW_WORKSPACE_DIR", "/root/.openclaw/workspace"))
    workspace.mkdir(parents=True, exist_ok=True)

    file_map = {
        "system_prompt.md": "SOUL.md",
        "identity.md": "IDENTITY.md",
        "boot.md": "BOOT.md",
    }
    for role_file, workspace_name in file_map.items():
        src = role_dir / role_file
        if src.exists():
            (workspace / workspace_name).write_text(src.read_text())

    playbook_src = role_dir / "playbook_template.md"
    if playbook_src.exists():
        (workspace / "playbook.md").write_text(playbook_src.read_text())

    config_dir = Path("/data/agent/config")
    config_dir.mkdir(parents=True, exist_ok=True)
    policies_src = role_dir / "default_policies.json"
    if policies_src.exists():
        (config_dir / "policies.json").write_text(policies_src.read_text())


def _write_identity_files(uid: str, org_id: str) -> None:
    """Write AGENT_UID and AGENT_ORG to /data for other scripts to read."""
    Path("/data/agent_uid").write_text(uid)
    Path("/data/agent_org").write_text(org_id)
    logger.info("Wrote /data/agent_uid and /data/agent_org")


def _ensure_skills_dir() -> None:
    """Create the OpenClaw skills directory so sync can populate it.

    Skills live under the workspace per OpenClaw's documented layout.
    """
    workspace_dir = Path(os.getenv("OPENCLAW_WORKSPACE_DIR", "/root/.openclaw/workspace"))
    skills_dir = Path(os.getenv("OPENCLAW_SKILLS_DIR", str(workspace_dir / "skills")))
    skills_dir.mkdir(parents=True, exist_ok=True)


if __name__ == "__main__":
    main()
