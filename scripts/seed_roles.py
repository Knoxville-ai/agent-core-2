#!/usr/bin/env python3
"""One-shot: seed the roles catalog from the filesystem ``roles/`` directory.

Reads every ``/app/roles/{slug}/`` folder, upserts a row into ``public.roles``,
and uploads the markdown blobs to Supabase Storage under
``roles/{slug}/v{version}/``. Safe to re-run — it upserts rather than inserts.

Usage (from inside the running container, or in CI with the env vars set):

    python3 /app/scripts/seed_roles.py

Required env vars:
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY

Optional env vars:
    ROLES_SRC_DIR   Override the source directory (default /app/roles).

Exits 0 on full success, 2 if any role failed to seed.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, "/app")

from app.agent.roles_catalog import BLOB_FILES, RoleRow, RolesCatalog
from app.storage.supabase_storage import SupabaseStorage

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("seed_roles")

ROLES_SRC_DIR = Path(os.getenv("ROLES_SRC_DIR", "/app/roles"))

# Metadata for the roles this repo ships. Anything not listed here is seeded
# as a prompt-only ``telegram_chat`` role by default.
_BUILTIN_METADATA: dict[str, dict[str, str]] = {
    "telegram_chat": {
        "display_name": "Telegram Chat",
        "description": "Default prompt-only Telegram assistant. Clone this in the console to create new specialized roles without rebuilding the image.",
        "icon": "💬",
        "capability": "telegram_chat",
    },
    "ap_invoices": {
        "display_name": "AP Invoices",
        "description": "Accounts payable invoice processing with Telegram chat interface.",
        "icon": "🥓",
        "capability": "ap_invoices",
    },
    "ebay_listings": {
        "display_name": "eBay Listings",
        "description": "Autonomous eBay storefront management with Odoo inventory sync.",
        "icon": "🏷️",
        "capability": "ebay_listings",
    },
    "knowledge_retrieval": {
        # Present here for the seed script's benefit when the
        # claude/document-knowledge-retrieval-vnScw branch merges. The
        # capability name matches what will be registered in
        # app/runtime/capabilities_builtin.py once that hook is wired up.
        "display_name": "Knowledge Retrieval",
        "description": "Document Q&A over an admin-curated Supabase knowledge base.",
        "icon": "📚",
        "capability": "knowledge_retrieval",
    },
    "product_mockup": {
        "display_name": "Product Mockup",
        "description": "Composes decoration images onto blank product photos using ratio-based placement rules. Deterministic — no generative AI. Agent can edit the rules catalog at runtime; it round-trips to Supabase.",
        "icon": "🎨",
        "capability": "product_mockup",
    },
    "artist": {
        "display_name": "Artist",
        "description": "Apparel mockups and original artwork. Looks up blank products by SKU + color via Google image search, runs the deterministic product_mockup pipeline first, falls back to gpt-image-1 with strict color-fidelity prompts on request. Also generates original artwork from reference images and a theme.",
        "icon": "🎨",
        "capability": "artist",
    },
}


def _read_version(role_dir: Path) -> int:
    f = role_dir / "VERSION"
    if not f.exists():
        return 1
    try:
        return int(f.read_text().strip())
    except ValueError:
        logger.warning("%s: invalid VERSION — using 1", role_dir.name)
        return 1


def _read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        logger.warning("%s: invalid JSON — using empty", path)
        return {}


def seed() -> int:
    url = os.getenv("SUPABASE_URL", "").strip()
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        logger.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
        return 1

    storage = SupabaseStorage(url, key)
    catalog = RolesCatalog(url, key, storage)

    if not ROLES_SRC_DIR.is_dir():
        logger.error("No roles directory at %s", ROLES_SRC_DIR)
        return 1

    success = 0
    failures = 0

    for role_dir in sorted(ROLES_SRC_DIR.iterdir()):
        if not role_dir.is_dir():
            continue
        slug = role_dir.name

        version = _read_version(role_dir)
        default_policies = _read_json(role_dir / "default_policies.json")
        policy_schema = _read_json(role_dir / "policy_schema.json")

        meta = _BUILTIN_METADATA.get(slug, {})
        display_name = meta.get("display_name", slug.replace("_", " ").title())
        description = meta.get("description", "")
        icon = meta.get("icon", "")
        capability = meta.get("capability", "telegram_chat")

        row = RoleRow(
            slug=slug,
            display_name=display_name,
            description=description,
            icon=icon,
            version=version,
            capability=capability,
            default_policies=default_policies,
            policy_schema=policy_schema,
            is_active=True,
        )

        if not catalog.upsert_role(row):
            failures += 1
            continue

        # Upload prompt blobs
        blob_ok = True
        for filename in BLOB_FILES:
            src = role_dir / filename
            if not src.exists():
                logger.warning("%s: missing %s — skipping blob", slug, filename)
                continue
            if not catalog.upload_blob(slug, version, filename, src.read_text()):
                blob_ok = False

        if blob_ok:
            success += 1
            logger.info("seeded %s v%d (capability=%s)", slug, version, capability)
        else:
            failures += 1
            logger.error("partial seed for %s — at least one blob upload failed", slug)

    logger.info("seed complete: %d success, %d failures", success, failures)
    return 0 if failures == 0 else 2


if __name__ == "__main__":
    sys.exit(seed())
