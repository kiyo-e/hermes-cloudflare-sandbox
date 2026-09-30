"""Official Hermes Terminal Environment Provider integration."""
from __future__ import annotations

from agent.terminal_env_provider import TerminalEnvironmentProvider

from .config import Config, SECRET_KEYS, as_bool, validate_cwd


def _config() -> Config:
    from agent.secret_scope import get_secret
    from hermes_constants import get_hermes_home

    # Never fall back to process-wide secrets after a profile-scope failure.
    return Config.from_env(secret_reader=get_secret, profile=str(get_hermes_home()))


class CloudflareSandboxProvider(TerminalEnvironmentProvider):
    name = "cloudflare_sandbox"
    display_name = "Cloudflare Sandbox"
    is_remote = True
    is_container = True
    skip_container_guards = False
    session_isolated_when_nonpersistent = True

    @property
    def description(self):
        return "Run terminal tools in Cloudflare Containers through an authenticated Worker."

    @property
    def env_description(self):
        return "Remote Linux container on Cloudflare; Bash, Python and Node.js; no host filesystem mount."

    @property
    def strip_env_keys(self):
        return SECRET_KEYS

    @property
    def cache_path_base(self):
        # Do not claim host cache/credential synchronization: it is intentionally disabled.
        return None

    def is_available(self):
        try:
            _config()
            return True
        except Exception:
            return False

    def create_environment(self, *, cwd, timeout, task_id="default", image=None,
                           container_config=None, **kwargs):
        from .environment import CloudflareSandboxEnvironment

        cc = container_config or {}
        persistent = as_bool(cc.get("container_persistent"), default=False)
        # Probe environments must not reuse or checkpoint the real workspace.
        if kwargs.get("probe_only") or task_id == "prompt-backend-probe":
            persistent = False
        return CloudflareSandboxEnvironment(
            _config(), cwd=validate_cwd(cwd), timeout=timeout, task_id=str(task_id),
            persistent=persistent,
        )
