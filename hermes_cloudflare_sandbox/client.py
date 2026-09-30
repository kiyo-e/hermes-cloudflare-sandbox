"""Small, dependency-free authenticated bridge client.

Mutating requests, particularly exec, are NEVER automatically retried. A lost
response can mean that the command already ran. Redirects are disabled so an
Authorization header cannot be forwarded to another origin.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from collections.abc import Iterator
from typing import Any

from . import __version__
from .config import Config

MAX_BODY = 1_048_576
MAX_FRAME = 65_536
ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,62}\Z")
# Cloudflare's default bot protection rejects urllib's "Python-urllib/x.y" agent
# with error 1010 before the Worker runs, so always identify the client explicitly.
USER_AGENT = f"hermes-cloudflare-sandbox/{__version__}"


class BridgeError(RuntimeError):
    def __init__(self, message: str, *, code: str = "bridge_error", status: int | None = None):
        super().__init__(message)
        self.code, self.status = code, status


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class BridgeClient:
    def __init__(self, config: Config):
        self.config = config
        self._opener = urllib.request.build_opener(_NoRedirect())

    def _open(self, method: str, path: str, data: dict | None = None, *, timeout: float = 90):
        body = None if data is None else json.dumps(data, ensure_ascii=False).encode("utf-8")
        if body is not None and len(body) > MAX_BODY:
            raise BridgeError("Request exceeds the bridge's 1 MiB limit", code="payload_too_large")
        headers = {"Authorization": f"Bearer {self.config.token}", "Accept": "application/json",
                   "User-Agent": USER_AGENT}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if self.config.access_client_id:
            headers["CF-Access-Client-Id"] = self.config.access_client_id
            headers["CF-Access-Client-Secret"] = self.config.access_client_secret
        req = urllib.request.Request(self.config.endpoint + path, body, headers, method=method)
        try:
            return self._opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as exc:
            status = exc.code
            # Do not print arbitrary server/Access error pages or echoed credentials.
            code = "http_error"
            try:
                error = json.loads(exc.read(MAX_FRAME)).get("error", {})
                candidate = error.get("code", "")
                if re.fullmatch(r"[a-z_]{1,64}", candidate):
                    code = candidate
            except (ValueError, TypeError, AttributeError):
                pass
            finally:
                exc.close()
            raise BridgeError(f"Cloudflare bridge returned HTTP {status} ({code})",
                              code=code, status=status) from None
        except (urllib.error.URLError, OSError, TimeoutError):
            raise BridgeError(
                "Cloudflare bridge connection failed. The operation may already have run; "
                "inspect the workspace before repeating a command.", code="connection_error"
            ) from None

    def request(self, method: str, path: str, data: dict | None = None, *, timeout: float = 90) -> dict:
        with self._open(method, path, data, timeout=timeout) as response:
            raw = response.read(MAX_BODY + 1)
        if len(raw) > MAX_BODY:
            raise BridgeError("Oversized bridge response", code="protocol_error")
        try:
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise ValueError()
            return result
        except (ValueError, UnicodeError):
            raise BridgeError("Invalid bridge JSON response", code="protocol_error") from None

    @staticmethod
    def path(sandbox_id: str, suffix: str = "") -> str:
        if not ID_RE.fullmatch(sandbox_id):
            raise ValueError("Invalid sandbox identifier")
        return f"/v1/sandboxes/{sandbox_id}{suffix}"

    def configure(self, sandbox_id: str, *, persistent: bool, cwd: str) -> dict:
        data: dict[str, Any] = {"persistent": persistent, "cwd": cwd, "image": self.config.image}
        if self.config.instance:
            data["instance"] = self.config.instance
        return self.request("POST", self.path(sandbox_id), data)

    def events(self, sandbox_id: str, *, request_id: str, command: str, timeout: float,
               login: bool = False, stdin_data: str | None = None) -> Iterator[dict]:
        if not re.fullmatch(r"[a-f0-9]{32}", request_id):
            raise ValueError("Invalid command request identifier")
        payload = {"request_id": request_id, "command": command, "timeout": timeout,
                   "login": login, "stdin": stdin_data}
        seen_exit = False
        try:
            with self._open("POST", self.path(sandbox_id, "/exec"), payload,
                            timeout=max(90, timeout + 75)) as response:
                if response.headers.get_content_type() != "application/x-ndjson":
                    raise BridgeError("Expected an NDJSON command stream", code="protocol_error")
                while True:
                    line = response.readline(MAX_FRAME + 1)
                    if not line:
                        break
                    if len(line) > MAX_FRAME or not line.endswith(b"\n"):
                        raise BridgeError("Invalid command stream frame", code="protocol_error")
                    try:
                        event = json.loads(line)
                    except (ValueError, UnicodeError):
                        raise BridgeError("Invalid command stream JSON", code="protocol_error") from None
                    if not isinstance(event, dict):
                        raise BridgeError("Invalid command stream event", code="protocol_error")
                    kind = event.get("type")
                    if seen_exit:
                        raise BridgeError("Data after command completion", code="protocol_error")
                    if kind in {"heartbeat", "started"}:
                        continue
                    if kind == "error":
                        code = event.get("code", "exec_failed")
                        if not isinstance(code, str) or not re.fullmatch(r"[a-z_]{1,64}", code):
                            code = "exec_failed"
                        raise BridgeError(f"Cloudflare execution failed ({code}); do not blindly retry",
                                          code=code)
                    if kind == "output" and isinstance(event.get("data"), str):
                        yield event
                    elif kind == "exit" and type(event.get("exit_code")) is int:
                        seen_exit = True
                        yield event
                    else:
                        raise BridgeError("Unknown command stream event", code="protocol_error")
        except (OSError, TimeoutError):
            raise BridgeError("Command stream disconnected; execution outcome is unknown",
                              code="connection_error") from None
        if not seen_exit:
            raise BridgeError("Command stream ended without an exit status; outcome is unknown",
                              code="incomplete_stream")

    def cancel(self, sandbox_id: str, request_id: str) -> dict:
        if not re.fullmatch(r"[a-f0-9]{32}", request_id):
            raise ValueError("Invalid command request identifier")
        return self.request("POST", self.path(sandbox_id, f"/cancel/{request_id}"), {}, timeout=5)

    def release(self, sandbox_id: str, *, force_remove: bool = False) -> dict:
        if force_remove:
            return self.request("DELETE", self.path(sandbox_id), {"confirm": True})
        return self.request("POST", self.path(sandbox_id, "/release"), {})
