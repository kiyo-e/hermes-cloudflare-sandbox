#!/usr/bin/env python3
"""Supervise one Bash invocation for the Cloudflare bridge.

Usage:
  hermes-exec [--id REQUEST_ID] TIMEOUT (-c|-lc) COMMAND
  hermes-exec --kill REQUEST_ID

stdin is inherited byte-for-byte. stdout/stderr are relayed through pipes owned
by this supervisor instead of being handed to Bash directly. A background job
(`cmd &`, `nohup ... &`) can therefore hold only the inner pipe open; this
process's own stdout, which the Worker streams, closes as soon as the
supervisor exits.

After Bash exits, every byte already buffered is delivered, then the pipes are
drained until DRAIN_IDLE passes with no new output, capped at DRAIN_GRACE for a
descendant that never goes quiet. Background jobs keep running after a normal
exit. This drain design is ported from openclaw/crabbox
(worker/cloudflare-container-runner/main.go, MIT License).

Timeout/cancel signals go to the Bash process group and are escalated to
SIGKILL after KILL_GRACE, or earlier once the group is gone. With --id, the
process group is recorded so `--kill REQUEST_ID` can stop it even if this
supervisor itself is stuck. This is resource management, not a security
boundary against code deliberately escaping its process group.
"""
from __future__ import annotations

import array
import fcntl
import math
import os
import re
import select
import signal
import subprocess
import sys
import termios
import time


def _seconds(name: str, default: float) -> float:
    # Tests shorten these; production uses the defaults.
    try:
        value = float(os.environ.get(name, default))
    except ValueError:
        return default
    return value if math.isfinite(value) and value > 0 else default


DRAIN_IDLE = _seconds("HERMES_EXEC_DRAIN_IDLE", 0.3)
DRAIN_GRACE = _seconds("HERMES_EXEC_DRAIN_GRACE", 5.0)
KILL_GRACE = 2.0
POLL = 0.05
CHUNK = 65536
STATE_DIR = os.environ.get("HERMES_EXEC_STATE_DIR", "/tmp/hermes-exec")
REQUEST_ID = re.compile(r"[a-f0-9]{32}\Z")
USAGE = "Usage: hermes-exec [--id REQUEST_ID] TIMEOUT (-c|-lc) COMMAND | hermes-exec --kill REQUEST_ID"


def _buffered(fd: int) -> int:
    count = array.array("i", [0])
    fcntl.ioctl(fd, termios.FIONREAD, count, True)
    return count[0]


def _group_alive(pgid: int) -> bool:
    """True while a non-zombie member of the process group exists.

    PID 1 in the container may not reap orphans, so a plain kill(-pgid, 0)
    would keep reporting zombies as alive.
    """
    try:
        entries = os.listdir("/proc")
    except OSError:
        entries = None
    if entries is None:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            pass
        return True
    for entry in entries:
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat", "rb") as handle:
                stat = handle.read()
        except OSError:
            continue
        # Fields after the parenthesized command: state ppid pgrp ...
        fields = stat[stat.rfind(b")") + 2:].split()
        if len(fields) >= 3 and int(fields[2]) == pgid and fields[0] != b"Z":
            return True
    return False


def _killpg(pgid: int, signum: int) -> None:
    try:
        os.killpg(pgid, signum)
    except ProcessLookupError:
        pass


class Relay:
    """Copy nonblocking inner pipes to this process's stdout/stderr."""

    def __init__(self, pairs: list[tuple[int, int]]):
        self.targets = dict(pairs)
        self.copied = 0
        self.broken: set[int] = set()
        for fd in self.targets:
            os.set_blocking(fd, False)

    @property
    def open(self) -> bool:
        return bool(self.targets)

    def _emit(self, target: int, data: bytes) -> None:
        if target in self.broken:
            return  # The reader went away; keep draining so the child never blocks.
        view = memoryview(data)
        while view:
            try:
                written = os.write(target, view)
            except BrokenPipeError:
                self.broken.add(target)
                return
            view = view[written:]

    def _read(self, fd: int, limit: int = CHUNK) -> int:
        try:
            data = os.read(fd, limit)
        except BlockingIOError:
            return 0
        if not data:
            os.close(fd)
            del self.targets[fd]
            return 0
        self._emit(self.targets[fd], data)
        self.copied += len(data)
        return len(data)

    def pump(self, timeout: float) -> None:
        if not self.targets:
            time.sleep(timeout)
            return
        ready, _, _ = select.select(list(self.targets), [], [], timeout)
        for fd in ready:
            if fd in self.targets:
                self._read(fd)

    def drain_buffered(self) -> None:
        """Deliver the finite prefix buffered right now, before any drain timer starts."""
        for fd in list(self.targets):
            remaining = _buffered(fd)
            while remaining > 0 and fd in self.targets:
                count = self._read(fd, min(remaining, CHUNK))
                if count == 0:
                    break
                remaining -= count

    def close(self) -> None:
        for fd in self.targets:
            os.close(fd)
        self.targets.clear()


def _state_path(request_id: str) -> str:
    return os.path.join(STATE_DIR, request_id)


def kill_recorded(args: list[str]) -> int:
    """Stop a recorded command without touching the rest of the container."""
    if len(args) != 1 or not REQUEST_ID.fullmatch(args[0]):
        print(USAGE, file=sys.stderr)
        return 64
    path = _state_path(args[0])
    try:
        with open(path, encoding="ascii") as handle:
            pgid, supervisor = (int(part) for part in handle.read().split())
    except FileNotFoundError:
        return 0  # Already finished and cleaned up.
    except ValueError:
        return 65
    if pgid > 1:
        _killpg(pgid, signal.SIGKILL)
    if supervisor > 1 and supervisor != os.getpid():
        try:
            os.kill(supervisor, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    return 0


def main(argv: list[str]) -> int:
    if argv[:1] == ["--kill"]:
        return kill_recorded(argv[1:])
    request_id = None
    if argv[:1] == ["--id"]:
        if len(argv) < 2 or not REQUEST_ID.fullmatch(argv[1]):
            print(USAGE, file=sys.stderr)
            return 64
        request_id, argv = argv[1], argv[2:]
    if len(argv) != 3 or argv[1] not in {"-c", "-lc"}:
        print(USAGE, file=sys.stderr)
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
    # A vanished Worker reader must surface as EPIPE, not kill the supervisor.
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)

    out_r, out_w = os.pipe()
    err_r, err_w = os.pipe()
    try:
        child = subprocess.Popen(["/bin/bash", argv[1], argv[2]], stdout=out_w, stderr=err_w,
                                 start_new_session=True,
                                 restore_signals=True)
    except OSError as exc:
        for fd in (out_r, out_w, err_r, err_w):
            os.close(fd)
        print(f"Cannot start bash: {exc.strerror}", file=sys.stderr)
        return 127
    # The child (and anything it forks) now holds the only write ends.
    os.close(out_w)
    os.close(err_w)

    state = None
    if request_id:
        try:
            os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
            state = _state_path(request_id)
            with open(state, "w", encoding="ascii") as handle:
                handle.write(f"{child.pid} {os.getpid()}\n")
        except OSError:
            state = None  # The Worker falls back to its own recovery path.

    relay = Relay([(out_r, 1), (err_r, 2)])
    try:
        deadline = time.monotonic() + timeout
        stopping = False
        escalation = math.inf
        while child.poll() is None:
            relay.pump(POLL)
            now = time.monotonic()
            if not stopping and (received_signal or now >= deadline):
                stopping = True
                _killpg(child.pid, received_signal or signal.SIGTERM)
                escalation = now + KILL_GRACE
            elif stopping and now >= escalation:
                _killpg(child.pid, signal.SIGKILL)
                escalation = now + KILL_GRACE
        status = child.returncode

        if stopping:
            # Bash is gone; give the rest of its group the remaining grace, then SIGKILL.
            while _group_alive(child.pid) and time.monotonic() < escalation:
                relay.pump(POLL)
            if _group_alive(child.pid):
                _killpg(child.pid, signal.SIGKILL)
            relay.drain_buffered()
            return 128 + received_signal if received_signal else 124

        # Normal exit: background jobs keep running; only stop waiting for their output.
        relay.drain_buffered()
        now = time.monotonic()
        grace_end, idle_end, last = now + DRAIN_GRACE, now + DRAIN_IDLE, relay.copied
        while relay.open and not received_signal:
            relay.pump(POLL)
            now = time.monotonic()
            if relay.copied != last:
                last, idle_end = relay.copied, now + DRAIN_IDLE
            if now >= idle_end or now >= grace_end:
                break
        return status if status >= 0 else 128 - status
    finally:
        relay.close()
        if state:
            try:
                os.unlink(state)
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
