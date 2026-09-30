import io
import json
import threading
from email.message import Message
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from hermes_cloudflare_sandbox.client import BridgeClient, BridgeError, MAX_FRAME
from hermes_cloudflare_sandbox.config import Config
from hermes_cloudflare_sandbox.process import RemoteProcessHandle

TOKEN = "test-token-" * 5
SID = "h-test"
RID = "a" * 32


class FakeResponse(io.BytesIO):
    def __init__(self, body, content_type="application/x-ndjson"):
        super().__init__(body)
        self.headers = Message()
        self.headers["content-type"] = content_type


def client_with_frames(monkeypatch, frames):
    client = BridgeClient(Config("https://sandbox.example", TOKEN))
    raw = b"".join(json.dumps(frame, ensure_ascii=False).encode() + b"\n" for frame in frames)
    monkeypatch.setattr(client, "_open", lambda *a, **k: FakeResponse(raw))
    return client


def events(client):
    return list(client.events(SID, request_id=RID, command="echo hello", timeout=5))


def test_unicode_and_exit_status(monkeypatch):
    c = client_with_frames(monkeypatch, [
        {"type": "heartbeat"}, {"type": "started"},
        {"type": "output", "data": "こんにちは\n🚀"}, {"type": "exit", "exit_code": 7},
    ])
    assert events(c) == [{"type": "output", "data": "こんにちは\n🚀"}, {"type": "exit", "exit_code": 7}]


def test_missing_exit_is_not_success(monkeypatch):
    c = client_with_frames(monkeypatch, [{"type": "output", "data": "partial"}])
    with pytest.raises(BridgeError, match="outcome is unknown"):
        events(c)


@pytest.mark.parametrize("frames", [
    [{"type": "exit", "exit_code": True}],
    [{"type": "exit", "exit_code": 0}, {"type": "output", "data": "late"}],
    [{"type": "unknown"}],
    [None],
])
def test_bad_frames(monkeypatch, frames):
    with pytest.raises(BridgeError):
        events(client_with_frames(monkeypatch, frames))


def test_remote_errors_do_not_echo_raw_error_text(monkeypatch):
    c = client_with_frames(monkeypatch, [{"type": "error", "code": "output_limit", "message": TOKEN}])
    with pytest.raises(BridgeError) as error:
        events(c)
    assert TOKEN not in str(error.value)
    assert error.value.code == "output_limit"


def test_oversized_frame(monkeypatch):
    c = client_with_frames(monkeypatch, [{"type": "output", "data": "a" * MAX_FRAME}])
    with pytest.raises(BridgeError, match="frame"):
        events(c)


def test_client_does_not_retry_or_follow_redirects():
    received = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            received.append(self.path)
            self.send_response(307)
            self.send_header("Location", "/would-leak-token")
            self.end_headers()
        def log_message(self, *args): pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        c = BridgeClient(Config(f"http://127.0.0.1:{server.server_port}", TOKEN))
        with pytest.raises(BridgeError) as error:
            c.request("POST", "/example", {})
        assert error.value.status == 307
        assert received == ["/example"]
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_process_handle_streams_and_handles_large_output(monkeypatch):
    text = "日本語🚀" * 30_000
    c = client_with_frames(monkeypatch, [
        *({"type": "output", "data": text[i:i + 4096]} for i in range(0, len(text), 4096)),
        {"type": "exit", "exit_code": 3},
    ])
    process = RemoteProcessHandle(c, SID, "test", timeout=10)
    assert process.stdout.read() == text
    assert process.wait(3) == 3
    assert process.poll() == 3
    assert process.error is None
    process.stdout.close()


def test_process_handle_reports_incomplete_stream(monkeypatch):
    c = client_with_frames(monkeypatch, [{"type": "output", "data": "partial"}])
    cancelled = []
    monkeypatch.setattr(c, "cancel", lambda *a: cancelled.append(a))
    p = RemoteProcessHandle(c, SID, "test", timeout=3)
    assert p.stdout.read() == "partial"
    assert p.wait(3) == 1
    assert isinstance(p.error, BridgeError)
    assert len(cancelled) == 1
    p.stdout.close()


def test_cancel_is_idempotent(monkeypatch):
    started, stop = threading.Event(), threading.Event()
    c = BridgeClient(Config("https://sandbox.example", TOKEN))
    def fake_events(*args, **kwargs):
        started.set()
        stop.wait(3)
        yield {"type": "exit", "exit_code": 143}
    calls = []
    monkeypatch.setattr(c, "events", fake_events)
    monkeypatch.setattr(c, "cancel", lambda *args: (calls.append(args), stop.set()))
    p = RemoteProcessHandle(c, SID, "sleep 10", timeout=10)
    assert started.wait(1)
    p.kill()
    p.kill()
    p.stdout.read()
    assert p.wait(3) == 143
    assert len(calls) == 1
    p.stdout.close()
