"""Streaming adapter for Hermes' ProcessHandle protocol (no Hermes dependency)."""
from __future__ import annotations

import contextvars
import os
import subprocess
import threading
import uuid

from .client import BridgeClient, BridgeError


class RemoteProcessHandle:
    def __init__(self, client: BridgeClient, sandbox_id: str, command: str, *,
                 timeout: float, login: bool = False, stdin_data: str | None = None):
        self.client, self.sandbox_id = client, sandbox_id
        self.request_id = uuid.uuid4().hex
        self._returncode: int | None = None
        self._error: Exception | None = None
        self._done = threading.Event()
        self._cancel_requested = threading.Event()
        self._cancel_lock = threading.Lock()
        read_fd, write_fd = os.pipe()
        self.stdout = os.fdopen(read_fd, "r", encoding="utf-8", errors="replace")

        def worker() -> None:
            try:
                for event in client.events(sandbox_id, request_id=self.request_id, command=command,
                                           timeout=timeout, login=login, stdin_data=stdin_data):
                    if event["type"] == "output":
                        remaining = memoryview(event["data"].encode("utf-8"))
                        # os.write is allowed to write fewer bytes than requested.
                        while remaining:
                            written = os.write(write_fd, remaining)
                            remaining = remaining[written:]
                    elif event["type"] == "exit":
                        self._returncode = event["exit_code"]
            except Exception as exc:
                self._error = exc
                self._returncode = 1
                # Best effort: disconnected streams must not leave unchecked commands.
                self.kill()
            finally:
                os.close(write_fd)
                self._done.set()

        context = contextvars.copy_context()
        self._thread = threading.Thread(target=context.run, args=(worker,), daemon=True,
                                        name=f"hermes-cloudflare-{self.request_id[:8]}")
        self._thread.start()

    @property
    def returncode(self) -> int | None:
        return self._returncode

    @property
    def error(self) -> Exception | None:
        return self._error

    def poll(self) -> int | None:
        return self._returncode if self._done.is_set() else None

    def wait(self, timeout: float | None = None) -> int:
        if not self._done.wait(timeout):
            raise subprocess.TimeoutExpired("cloudflare command", timeout)
        return self._returncode if self._returncode is not None else 1

    def kill(self) -> None:
        with self._cancel_lock:
            if self._cancel_requested.is_set() or self._done.is_set():
                return
            self._cancel_requested.set()
        try:
            self.client.cancel(self.sandbox_id, self.request_id)
        except BridgeError:
            # The server-side process supervisor and deadline remain in force.
            pass
