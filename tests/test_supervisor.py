"""These tests run real Bash/process groups locally, not Cloudflare VMs."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import pytest

RUNNER = Path(__file__).resolve().parents[1] / "worker/container/hermes-exec.py"


def run(command, *, stdin=None, timeout="5"):
    return subprocess.run([sys.executable, str(RUNNER), timeout, "-c", command],
                          input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)


def test_exit_status_and_unicode():
    result = run("printf '日本語🚀'; exit 7")
    assert result.returncode == 7
    assert result.stdout.decode() == "日本語🚀"


def test_stdin_is_byte_exact():
    data = b"no-final-newline\x00\r\n" + "日本語".encode()
    assert run("cat", stdin=data).stdout == data


def test_separate_stderr():
    result = run("printf out; printf err >&2")
    assert result.stdout == b"out"
    assert result.stderr == b"err"


def test_timeout_terminates_group():
    start = time.monotonic()
    result = run("sleep 60 & wait", timeout="0.1")
    assert result.returncode == 124
    assert time.monotonic() - start < 5


def test_cancel_forwards_signal_and_kills_stubborn_descendants(tmp_path):
    pidfile = tmp_path / "child.pid"
    command = f"bash -c 'trap \"\" TERM; echo $$ > {pidfile}; while :; do sleep 1; done' & wait"
    process = subprocess.Popen([sys.executable, str(RUNNER), "60", "-c", command],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for _ in range(100):
            if pidfile.exists(): break
            time.sleep(0.02)
        assert pidfile.exists()
        child = int(pidfile.read_text())
        process.send_signal(signal.SIGTERM)
        process.communicate(timeout=6)
        assert process.returncode == 143
        # A zombie is terminated but awaits reaping by this container's PID 1.
        stat = Path(f"/proc/{child}/stat")
        assert not stat.exists() or stat.read_text().split()[2] == "Z"
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


@pytest.mark.parametrize("value", ["nan", "inf", "0", "-1", "901", "wrong"])
def test_invalid_timeout(value):
    assert run("echo should-not-run", timeout=value).returncode == 64
