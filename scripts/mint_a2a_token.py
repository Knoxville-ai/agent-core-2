#!/usr/bin/env python3
"""Mint an agent-to-agent service JWT for testing.

Handy during the Phase 1c verification flow described in the plan file:
you stand up two dummy agents, insert an agent_connections row linking
them, then use this script to POST an A2A message against the target's
Flask gateway to verify the allowlist + JWT verification path.

Usage:
    python scripts/mint_a2a_token.py \
        --sub <caller_uid> \
        --aud <target_uid> \
        --org <org_id> \
        --exp 300

Reads SUPABASE_JWT_SECRET from the environment — must match the target
agent's SUPABASE_JWT_SECRET so the verifier accepts it.
"""

from __future__ import annotations

import argparse
import os
import sys

from app.messaging.a2a_client import mint_service_jwt


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sub", required=True, help="caller agent uid")
    parser.add_argument("--aud", required=True, help="target agent uid")
    parser.add_argument("--org", required=True, help="org id")
    parser.add_argument(
        "--exp",
        type=int,
        default=300,
        help="token lifetime in seconds (default 300)",
    )
    args = parser.parse_args()

    secret = os.environ.get("SUPABASE_JWT_SECRET", "").strip()
    if not secret:
        print(
            "error: SUPABASE_JWT_SECRET must be set in the environment",
            file=sys.stderr,
        )
        return 1

    token = mint_service_jwt(
        caller_uid=args.sub,
        target_uid=args.aud,
        org_id=args.org,
        secret=secret,
        ttl_seconds=args.exp,
    )
    print(token)
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
