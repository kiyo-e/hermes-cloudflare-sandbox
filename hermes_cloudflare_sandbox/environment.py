"""Reuse Hermes' shell wrapping, CWD markers, stdin and process management."""
from __future__ import annotations

import threading

from tools.environments.base import BaseEnvironment, EnvironmentConnectionError

from .client import BridgeClient, BridgeError
from .config import Config, validate_cwd
from .process import RemoteProcessHandle


class CloudflareSandboxEnvironment(BaseEnvironment):
    _snapshot_timeout = 120
    _stdin_mode = "pipe"

    def __init__(self, config: Config, *, cwd: str = "/workspace", timeout: int = 120,
                 task_id: str = "default", persistent: bool = False):
        super().__init__(cwd=validate_cwd(cwd), timeout=timeout)
        self.task_id, self.persistent = task_id, persistent
        self.sandbox_id = config.sandbox_id(task_id, persistent=persistent)
        self._client = BridgeClient(config)
        self._lock = threading.RLock()
        self._closed = False
        self._configured = False
        self._last_process: RemoteProcessHandle | None = None
        try:
            self._client.configure(self.sandbox_id, persistent=persistent, cwd=self.cwd)
            self._configured = True
            self.init_session()
            self._raise_transport_error()
        except Exception:
            # Do not erase a persistent workspace on an initialization failure.
            try:
                self.cleanup()
            except Exception:
                pass
            raise

    def _run_bash(self, cmd_string: str, *, login: bool = False, timeout: int = 120,
                  stdin_data: str | None = None):
        if self._closed:
            raise EnvironmentConnectionError("Cloudflare environment is closed")
        handle = RemoteProcessHandle(self._client, self.sandbox_id, cmd_string,
                                     timeout=timeout, login=login, stdin_data=stdin_data)
        self._last_process = handle
        return handle

    def _raise_transport_error(self):
        if self._last_process is not None and self._last_process.error is not None:
            error = self._last_process.error
            message = str(error) if isinstance(error, BridgeError) else "Cloudflare execution transport failed"
            raise EnvironmentConnectionError(
                message,
                retry_hint="The command may already have executed. Inspect workspace state before retrying.",
            ) from None

    def execute(self, *args, **kwargs):
        with self._lock:
            result = super().execute(*args, **kwargs)
            self._raise_transport_error()
            # Hermes core uses returncode; the provider guide also documents exit_code.
            if "returncode" in result:
                result.setdefault("exit_code", result["returncode"])
            return result

    def cleanup(self, *, force_remove: bool = False):
        if not hasattr(self, "_lock"):
            return
        with self._lock:
            if self._closed or not self._configured:
                return
            self._client.release(self.sandbox_id, force_remove=force_remove)
            self._closed = True
