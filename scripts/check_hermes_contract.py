#!/usr/bin/env python3
"""Check the REAL installed Hermes interface; no substitute/stub modules.

Run with the Python environment that runs Hermes and --hermes-source if its
checkout is not already importable. This does not contact Cloudflare.
"""
from __future__ import annotations

import argparse
import inspect
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-source", type=Path)
    args = parser.parse_args()
    if args.hermes_source:
        sys.path.insert(0, str(args.hermes_source.expanduser().resolve()))
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    try:
        from agent.terminal_env_provider import TerminalEnvironmentProvider
        from agent.secret_scope import get_secret
        from hermes_constants import get_hermes_home
        from tools.environments.base import BaseEnvironment, EnvironmentConnectionError
        from hermes_cloudflare_sandbox.environment import CloudflareSandboxEnvironment
        from hermes_cloudflare_sandbox.provider import CloudflareSandboxProvider
    except ImportError as exc:
        print(f"FAIL: Use a current Hermes Python environment; import failed: {exc}", file=sys.stderr)
        return 1
    errors = []
    if inspect.isabstract(CloudflareSandboxProvider):
        errors.append(f"Provider has unimplemented abstract methods: {CloudflareSandboxProvider.__abstractmethods__}")
    if inspect.isabstract(CloudflareSandboxEnvironment):
        errors.append("Environment has unimplemented abstract methods")
    if not issubclass(CloudflareSandboxProvider, TerminalEnvironmentProvider):
        errors.append("Unexpected provider base")
    for method in ("init_session", "execute", "_run_bash"):
        if not callable(getattr(BaseEnvironment, method, None)):
            errors.append(f"BaseEnvironment.{method} is unavailable")
    execute = inspect.signature(BaseEnvironment.execute).parameters
    for parameter in ("timeout", "stdin_data", "bounded_capture"):
        if parameter not in execute:
            errors.append(f"BaseEnvironment.execute lacks {parameter}")
    if "retry_hint" not in inspect.signature(EnvironmentConnectionError).parameters:
        errors.append("EnvironmentConnectionError lacks retry_hint")
    if not callable(get_secret) or not callable(get_hermes_home):
        errors.append("Hermes profile helpers are unavailable")
    if errors:
        print("FAIL:\n" + "\n".join(errors), file=sys.stderr)
        return 1
    provider = CloudflareSandboxProvider()
    assert provider.name == "cloudflare_sandbox"
    assert not provider.skip_container_guards
    print("PASS: installed Hermes interfaces match the adapter's required contract.")
    print("This checks imports/signatures, not live backend operation or shell-state behavior.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
