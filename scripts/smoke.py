#!/usr/bin/env python3
"""Opt-in LIVE Cloudflare bridge test. Creates paid compute and a disposable snapshot.

Environment: HERMES_CF_ENDPOINT, HERMES_CF_TOKEN, optionally IMAGE/INSTANCE/ACCESS.
A fresh random workspace identity overrides HERMES_CF_WORKSPACE, so a real project
is never reused or deleted. A Cloudflare snapshot can outlive cleanup until TTL.
"""
from __future__ import annotations

import argparse
import sys
import uuid
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hermes_cloudflare_sandbox.client import BridgeClient
from hermes_cloudflare_sandbox.config import Config


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Explicitly allow paid Cloudflare execution")
    args = parser.parse_args()
    if not args.live:
        parser.error("Pass --live to allow creating a temporary Cloudflare container and snapshot")
    config = replace(Config.from_env(), namespace=f"smoke-{uuid.uuid4().hex}", workspace=None)
    client = BridgeClient(config)
    sandbox_id = config.sandbox_id("disposable", persistent=True)
    created = False

    def execute(command: str, *, stdin: str | None = None, expected_code: int = 0, timeout: float = 30) -> str:
        output, code = [], None
        for event in client.events(sandbox_id, request_id=uuid.uuid4().hex, command=command,
                                   timeout=timeout, stdin_data=stdin):
            if event["type"] == "output":
                output.append(event["data"])
            if event["type"] == "exit":
                code = event["exit_code"]
        if code != expected_code:
            raise RuntimeError(f"Unexpected exit status {code}, expected {expected_code}")
        return "".join(output)

    try:
        assert client.request("GET", "/health")["ok"] is True
        client.configure(sandbox_id, persistent=True, cwd="/workspace")
        created = True
        text = "日本語と🚀\n$(this-is-data-not-shell)\n"
        assert execute("cat", stdin=text) == text
        execute("exit 7", expected_code=7)
        execute("sleep 10", timeout=0.2, expected_code=124)
        marker = uuid.uuid4().hex
        execute(f"printf %s '{marker}' > /workspace/.hermes-cf-smoke")
        client.release(sandbox_id)
        assert client.request("GET", client.path(sandbox_id))["running"] is False
        assert execute("cat /workspace/.hermes-cf-smoke") == marker
        print("PASS: authenticated exec, Unicode stdin, nonzero exit, timeout, snapshot and restore.")
        print("Hermes shell/file tool integration must still be checked separately.")
        return 0
    finally:
        if created:
            # This only deletes the fresh smoke-test identity, never HERMES_CF_WORKSPACE.
            client.release(sandbox_id, force_remove=True)


if __name__ == "__main__":
    raise SystemExit(main())
