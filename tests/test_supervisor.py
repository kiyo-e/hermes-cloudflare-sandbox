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


# The drain tests below are ported from openclaw/crabbox
# worker/cloudflare-container-runner/stdout_truncation_test.go (MIT License).

def run_until_eof(command, *, env=None, timeout="20"):
    """Time until the supervisor's OWN stdout closes, which is what the Worker waits for."""
    start = time.monotonic()
    result = subprocess.run([sys.executable, str(RUNNER), timeout, "-c", command],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
                            env={**os.environ, **(env or {})})
    return result, time.monotonic() - start


def test_background_descendant_does_not_hold_the_stream_open(tmp_path):
    marker = tmp_path / "still-running"
    result, elapsed = run_until_eof(f"(sleep 3; touch {marker}) & echo done")
    assert result.returncode == 0
    assert result.stdout == b"done\n"
    assert elapsed < 2, elapsed  # well under the 5 s drain cap
    # A normal exit must not kill background jobs.
    for _ in range(100):
        if marker.exists():
            break
        time.sleep(0.05)
    assert marker.exists()


def test_hermes_background_spawn_pattern_returns_promptly(tmp_path):
    # Shape used by Hermes' process registry for terminal(background=true).
    log, rc = tmp_path / "bg.log", tmp_path / "bg.exit"
    command = (f"( nohup bash -lc 'sleep 3; echo late' > {log} 2>&1; "
               f"rc=$?; printf '%s\\n' \"$rc\" > {rc} ) & echo $!")
    result, elapsed = run_until_eof(command)
    assert result.returncode == 0
    assert result.stdout.strip().isdigit()
    assert elapsed < 2, elapsed


def test_noisy_background_descendant_is_bounded():
    result, elapsed = run_until_eof("(while true; do echo x; done) & echo done",
                                    env={"HERMES_EXEC_DRAIN_GRACE": "1"})
    assert result.returncode == 0
    assert result.stdout.startswith(b"done\n") or b"done\n" in result.stdout
    assert elapsed < 4, elapsed


def test_bursty_background_output_is_delivered_before_idle():
    # Each gap is shorter than the idle window, so every burst must arrive.
    command = "(for i in 1 2 3 4 5; do echo burst-$i; sleep 0.1; done) & echo fg"
    result, _ = run_until_eof(command, env={"HERMES_EXEC_DRAIN_IDLE": "0.5"})
    assert result.returncode == 0
    for i in range(1, 6):
        assert f"burst-{i}\n".encode() in result.stdout


def test_large_foreground_output_is_not_truncated():
    # More than a pipe buffer, written right before exit.
    payload = "y" * 999 + "\n"
    result, _ = run_until_eof(f"for i in $(seq 1 3000); do printf '%s' '{payload}'; done; exit 3")
    assert result.returncode == 3
    assert result.stdout == payload.encode() * 3000


def test_cancel_returns_quickly_when_the_group_exits_on_term():
    process = subprocess.Popen([sys.executable, str(RUNNER), "60", "-c", "sleep 30"],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        time.sleep(0.3)
        start = time.monotonic()
        process.send_signal(signal.SIGTERM)
        process.communicate(timeout=6)
        assert process.returncode == 143
        assert time.monotonic() - start < 1
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def test_kill_by_request_id_stops_the_recorded_group(tmp_path):
    request_id = "a" * 32
    env = {**os.environ, "HERMES_EXEC_STATE_DIR": str(tmp_path)}
    process = subprocess.Popen([sys.executable, str(RUNNER), "--id", request_id, "60", "-c",
                                "trap '' TERM; sleep 30"],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    try:
        for _ in range(100):
            if (tmp_path / request_id).exists():
                break
            time.sleep(0.02)
        assert (tmp_path / request_id).exists()
        killer = subprocess.run([sys.executable, str(RUNNER), "--kill", request_id],
                                env=env, timeout=5)
        assert killer.returncode == 0
        process.communicate(timeout=5)
        assert process.returncode is not None
        assert not (tmp_path / request_id).exists()
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def test_kill_unknown_request_id_is_a_noop(tmp_path):
    env = {**os.environ, "HERMES_EXEC_STATE_DIR": str(tmp_path)}
    result = subprocess.run([sys.executable, str(RUNNER), "--kill", "b" * 32], env=env, timeout=5)
    assert result.returncode == 0
