#!/usr/bin/env python3
"""Supervise one Bash invocation, preserving stdin/stdout byte-for-byte.

The child owns its own process group. Timeout/cancel signals are forwarded to
that group, then escalated to SIGKILL. Normal completion does not kill detached
background jobs. This is resource management, not a security boundary against
code deliberately escaping its process group; the Worker also has a hard stop.
"""
from __future__ import annotations

import math
import os
import signal
import subprocess
import sys
import time


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] not in {"-c", "-lc"}:
        print("Usage: hermes-exec TIMEOUT (-c|-lc) COMMAND", file=sys.stderr)
        return 64
    try:
        timeout = float(argv[0])
        if not math.isfinite(timeout) or not 0.1 <= timeout <= 900:
            raise ValueError()
    except ValueError:
        print("Invalid command timeout", file=sys.stderr)
        return 64

    received_signal = 0

    def handle_signal(signum, _frame):
        nonlocal received_signal
        if not received_signal:
            received_signal = signum

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)
    child = subprocess.Popen(["/bin/bash", argv[1], argv[2]], start_new_session=True)
    deadline = time.monotonic() + timeout
    escalation: float | None = None
    timed_out = False
    while True:
        status = child.poll()
        now = time.monotonic()
        # Even if bash exits on TERM, kill the rest of the group after the grace
        # period (a descendant can ignore TERM and outlive the shell).
        if escalation is not None:
            if now >= escalation:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()
                return 124 if timed_out else 128 + received_signal
        elif status is not None:
            return status if status >= 0 else 128 - status
        elif now >= deadline or received_signal:
            timed_out = not bool(received_signal)
            signum = signal.SIGTERM if timed_out else received_signal
            try:
                os.killpg(child.pid, signum)
            except ProcessLookupError:
                pass
            escalation = now + 2.0
        time.sleep(0.02)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
