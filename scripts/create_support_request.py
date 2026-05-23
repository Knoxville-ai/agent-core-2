#!/usr/bin/env python3
"""Create a support/development request in Supabase.

Called by agents when they cannot fulfill a user request and need development
help.  This script is designed to be run from the agent's shell (via OpenClaw
tool execution).

Usage:
    python3 /app/scripts/create_support_request.py \
        --title "Need eBay bulk listing skill" \
        --description "User asked me to list 50 products on eBay from Odoo..." \
        --user-request "List all applicable products from Odoo on eBay" \
        --steps-attempted "Tried writing a Python script using eBay Sell API..." \
        --error-details "400 Bad Request: missing categoryId field" \
        --priority normal

All fields except --title are optional.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import requests


def main():
    parser = argparse.ArgumentParser(description="Create a support request")
    parser.add_argument("--title", required=True, help="Short summary of what's needed")
    parser.add_argument("--description", default="", help="Detailed description")
    parser.add_argument("--user-request", default="", help="What the user originally asked")
    parser.add_argument("--steps-attempted", default="", help="What the agent tried")
    parser.add_argument("--error-details", default="", help="Error messages or stack traces")
    parser.add_argument(
        "--priority",
        default="normal",
        choices=["low", "normal", "high"],
        help="Request priority (default: normal)",
    )
    args = parser.parse_args()

    supabase_url = os.getenv("SUPABASE_URL", "")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

    if not supabase_url or not supabase_key:
        print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set", file=sys.stderr)
        sys.exit(1)

    # Read agent identity from boot files
    agent_uid = ""
    agent_org = ""
    agent_role = os.getenv("AGENT_ROLE", "unknown")

    uid_path = "/data/agent_uid"
    org_path = "/data/agent_org"
    if os.path.exists(uid_path):
        agent_uid = open(uid_path).read().strip()
    if os.path.exists(org_path):
        agent_org = open(org_path).read().strip()

    payload = {
        "org_id": agent_org,
        "agent_uid": agent_uid,
        "agent_role": agent_role,
        "title": args.title,
        "description": args.description,
        "user_request": args.user_request,
        "steps_attempted": args.steps_attempted,
        "error_details": args.error_details,
        "priority": args.priority,
        "status": "open",
    }

    url = f"{supabase_url.rstrip('/')}/rest/v1/support_requests"
    headers = {
        "Authorization": f"Bearer {supabase_key}",
        "apikey": supabase_key,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }

    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=15)
    except Exception as exc:
        print(f"ERROR: Failed to submit request: {exc}", file=sys.stderr)
        sys.exit(1)

    if not resp.ok:
        print(f"ERROR: Supabase returned {resp.status_code}: {resp.text[:300]}", file=sys.stderr)
        sys.exit(1)

    result = resp.json()
    ticket_id = result[0]["id"] if isinstance(result, list) and result else "unknown"
    print(f"Support request created: {ticket_id}")
    print(f"Title: {args.title}")
    print(f"Priority: {args.priority}")
    print(f"Status: open")


if __name__ == "__main__":
    main()
