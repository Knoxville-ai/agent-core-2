#!/usr/bin/env python3
"""Push agent state to Supabase immediately.

The agent should run this script after editing playbook.md, installing a
skill, or editing any other file that should be persisted across restarts.
The periodic background sync also covers this, but explicit push gives
instant durability.

Usage:
    python3 /app/scripts/sync_to_supabase.py            # push everything
    python3 /app/scripts/sync_to_supabase.py memory     # push only memory dir
    python3 /app/scripts/sync_to_supabase.py skills     # push only skills dir
    python3 /app/scripts/sync_to_supabase.py config     # push only config dir
    python3 /app/scripts/sync_to_supabase.py mockup     # push product_mockup assets
    python3 /app/scripts/sync_to_supabase.py artist     # push artist assets
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, "/app")

from app.agent.sync import (
    _NESTED_SUBDIRS,
    _SUBDIR_MAP,
    push_all,
    push_artist,
    push_file,
    push_mockup,
    push_tree_file,
)
from app.storage.supabase_storage import SupabaseStorage

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("sync_to_supabase")


def main() -> None:
    supabase_url = os.getenv("SUPABASE_URL", "").strip()
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()

    if not supabase_url or not supabase_key:
        print("ERROR: Supabase not configured", file=sys.stderr)
        sys.exit(1)

    uid_path = Path("/data/agent_uid")
    if not uid_path.exists():
        print("ERROR: /data/agent_uid not found — boot script hasn't run", file=sys.stderr)
        sys.exit(1)
    uid = uid_path.read_text().strip()

    org_path = Path("/data/agent_org")
    org_id = org_path.read_text().strip() if org_path.exists() else "default"

    storage = SupabaseStorage(supabase_url, supabase_key)

    target = sys.argv[1] if len(sys.argv) > 1 else None

    if target == "mockup":
        count = push_mockup(storage, org_id, uid)
        print(f"Pushed {count} mockup file(s) (org={org_id} uid={uid})")
        return

    if target == "artist":
        count = push_artist(storage, org_id, uid)
        print(f"Pushed {count} artist file(s) (org={org_id} uid={uid})")
        return

    if target and target in _SUBDIR_MAP:
        local_dir = _SUBDIR_MAP[target]
        if not local_dir.exists():
            print(f"No files in {local_dir}", file=sys.stderr)
            return
        count = 0
        if target in _NESTED_SUBDIRS:
            # Recursive walk for nested dirs (skills)
            for path in local_dir.rglob("*"):
                if path.is_file():
                    if push_tree_file(storage, org_id, uid, target, local_dir, path):
                        count += 1
        else:
            for path in local_dir.iterdir():
                if path.is_file():
                    if push_file(storage, org_id, uid, target, path):
                        count += 1
        print(f"Pushed {count} files from {target} (org={org_id} uid={uid})")
    else:
        push_all(storage, org_id, uid)
        print(f"Pushed all agent state for org={org_id} uid={uid}")


if __name__ == "__main__":
    main()
