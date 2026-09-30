"""Validated configuration. No network or Hermes imports at module load time."""
from __future__ import annotations

import hashlib
import os
import re
import uuid
from dataclasses import dataclass, field
from typing import Callable
from urllib.parse import urlsplit, urlunsplit

SECRET_KEYS = frozenset({
    "HERMES_CF_TOKEN", "HERMES_CF_ACCESS_CLIENT_ID", "HERMES_CF_ACCESS_CLIENT_SECRET",
    "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "SANDBOX_API_TOKEN",
})
INSTANCE_TYPES = frozenset({"lite", "standard-1", "standard-2", "standard-3", "standard-4"})


def as_bool(value: object, *, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        if value.lower() in {"true", "1", "yes", "on"}:
            return True
        if value.lower() in {"false", "0", "no", "off"}:
            return False
    raise ValueError("Expected a boolean, not an arbitrary truthy value")


def validate_cwd(cwd: str | None) -> str:
    cwd = cwd or "/workspace"
    if cwd == "~":
        cwd = "/home/hermes"
    elif cwd.startswith("~/"):
        cwd = "/home/hermes/" + cwd[2:]
    if not cwd.startswith("/") or "\x00" in cwd or len(cwd.encode()) > 4096:
        raise ValueError("terminal.cwd must be an absolute path inside the sandbox")
    return cwd


@dataclass(frozen=True)
class Config:
    endpoint: str
    token: str = field(repr=False)
    namespace: str = "default"
    workspace: str | None = None
    image: str = "hermes"
    instance: str | None = None
    access_client_id: str = field(default="", repr=False)
    access_client_secret: str = field(default="", repr=False)

    def __post_init__(self) -> None:
        parts = urlsplit(self.endpoint)
        # HTTP is permitted only on an explicit loopback address for local tests.
        local = parts.hostname in {"localhost", "127.0.0.1", "::1"}
        if parts.scheme != "https" and not (parts.scheme == "http" and local):
            raise ValueError("HERMES_CF_ENDPOINT must use HTTPS (HTTP is loopback-only)")
        if (not parts.hostname or parts.username or parts.password or parts.query
                or parts.fragment or parts.path not in {"", "/"}):
            raise ValueError("HERMES_CF_ENDPOINT must be an origin without credentials, path, query or fragment")
        try:
            _ = parts.port
        except ValueError as exc:
            raise ValueError("Invalid endpoint port") from exc
        object.__setattr__(self, "endpoint", urlunsplit((parts.scheme, parts.netloc, "", "", "")))
        if len(self.token) < 32 or not self.token.isascii() or any(c.isspace() for c in self.token):
            raise ValueError("HERMES_CF_TOKEN must contain at least 32 non-whitespace ASCII characters")
        if self.instance is not None and self.instance not in INSTANCE_TYPES:
            raise ValueError("HERMES_CF_INSTANCE must be lite or standard-1 through standard-4")
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", self.image):
            raise ValueError("HERMES_CF_IMAGE must name an image deployed in wrangler.jsonc")
        if bool(self.access_client_id) != bool(self.access_client_secret):
            raise ValueError("Set both Cloudflare Access service-token fields or neither")
        for item in (self.access_client_id, self.access_client_secret):
            if "\r" in item or "\n" in item or "\x00" in item:
                raise ValueError("Invalid Cloudflare Access header")

    @classmethod
    def from_env(cls, *, secret_reader: Callable[[str], str | None] | None = None,
                 profile: str = "default") -> "Config":
        read_secret = secret_reader or os.getenv
        return cls(
            endpoint=os.getenv("HERMES_CF_ENDPOINT", ""),
            token=read_secret("HERMES_CF_TOKEN") or "",
            namespace=os.getenv("HERMES_CF_NAMESPACE") or profile,
            workspace=os.getenv("HERMES_CF_WORKSPACE") or None,
            image=os.getenv("HERMES_CF_IMAGE", "hermes"),
            instance=os.getenv("HERMES_CF_INSTANCE") or None,
            access_client_id=read_secret("HERMES_CF_ACCESS_CLIENT_ID") or "",
            access_client_secret=read_secret("HERMES_CF_ACCESS_CLIENT_SECRET") or "",
        )

    def sandbox_id(self, task_id: str, *, persistent: bool) -> str:
        # Hash untrusted/user-specific identity; never expose raw profile paths or task IDs.
        identity = f"{self.namespace}\x00{self.workspace or task_id}"
        digest = hashlib.sha256(identity.encode()).hexdigest()[:40]
        if persistent:
            return f"h-{digest}"
        # An ephemeral re-creation must never attach a previous session's VM.
        return f"h-{digest[:24]}-{uuid.uuid4().hex}"
