import dataclasses

import pytest

from hermes_cloudflare_sandbox.config import Config, as_bool, validate_cwd

TOKEN = "t" * 48


def config(**kwargs):
    return Config(endpoint="https://sandbox.example", token=TOKEN, **kwargs)


@pytest.mark.parametrize("url", ["http://example.com", "ftp://host", "https://user:pass@host",
    "https://host/path", "https://host?token=secret", "https://host/#x", "", "https://host:bad"])
def test_rejects_unsafe_endpoint(url):
    with pytest.raises(ValueError):
        Config(endpoint=url, token=TOKEN)


@pytest.mark.parametrize("url", ["http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787", "https://host/"])
def test_valid_origins(url):
    assert Config(endpoint=url, token=TOKEN).endpoint == url.rstrip("/")


@pytest.mark.parametrize("token", ["", "short", "t" * 40 + "\n", "あ" * 40, "a b" * 20])
def test_bad_tokens(token):
    with pytest.raises(ValueError):
        Config(endpoint="https://host", token=token)


def test_no_secret_in_repr():
    assert TOKEN not in repr(config())


def test_persistent_identity_is_stable_and_profile_scoped():
    a = config(namespace="profile-a")
    b = config(namespace="profile-b")
    assert a.sandbox_id("task", persistent=True) == a.sandbox_id("task", persistent=True)
    assert a.sandbox_id("task", persistent=True) != b.sandbox_id("task", persistent=True)
    assert "task" not in a.sandbox_id("task", persistent=True)


def test_ephemeral_identity_is_unique():
    c = config()
    assert c.sandbox_id("default", persistent=False) != c.sandbox_id("default", persistent=False)
    assert len(c.sandbox_id("default", persistent=False)) <= 63


def test_workspace_override():
    c = config(workspace="project")
    assert c.sandbox_id("one", persistent=True) == c.sandbox_id("two", persistent=True)


def test_booleans_are_not_python_truthiness():
    assert as_bool("false") is False
    assert as_bool("true") is True
    assert as_bool(None) is False
    with pytest.raises(ValueError):
        as_bool("maybe")


def test_cwd_paths():
    assert validate_cwd(None) == "/workspace"
    assert validate_cwd("~/repo") == "/home/hermes/repo"
    for bad in ["repo", "x\0", "/" + "a" * 4096]:
        with pytest.raises(ValueError):
            validate_cwd(bad)


def test_secret_scope_failure_has_no_fallback(monkeypatch):
    monkeypatch.setenv("HERMES_CF_ENDPOINT", "https://sandbox.example")
    monkeypatch.setenv("HERMES_CF_TOKEN", TOKEN)
    def deny(_):
        raise RuntimeError("wrong profile")
    with pytest.raises(RuntimeError, match="wrong profile"):
        Config.from_env(secret_reader=deny)


def test_instance_allowlist():
    with pytest.raises(ValueError):
        config(instance="basic")
    assert config(instance="standard-2").instance == "standard-2"


def test_access_token_pair_required():
    with pytest.raises(ValueError):
        config(access_client_id="client")
