# Bridge protocol v1

This is the protocol implemented by this repository, not a Cloudflare REST API.
The Python plugin connects to the public Worker; only the Worker accesses the
Durable Object's native Container API. One trusted owner is assumed.

All public routes require `Authorization: Bearer <SANDBOX_API_TOKEN>`.
Optional Cloudflare Access headers are sent by the Python client when configured.
Authorization happens before allocating a Durable Object. Redirects are refused
by the client. CORS is intentionally not enabled.

| Method | Path | Meaning |
| --- | --- | --- |
| GET | `/health` | Authenticate without starting a VM. |
| POST | `/v1/sandboxes/{id}` | Create immutable workspace metadata, without booting a VM. |
| GET | `/v1/sandboxes/{id}` | Read config, running/busy state and last snapshot timestamp. |
| POST | `/v1/sandboxes/{id}/exec` | Execute one command; return an NDJSON stream. |
| POST | `/v1/sandboxes/{id}/cancel/{request_id}` | Cancel one command; can arrive before exec. |
| POST | `/v1/sandboxes/{id}/checkpoint` | Save a persistent workspace without stopping it. |
| POST | `/v1/sandboxes/{id}/release` | Save/stop persistent workspaces; delete ephemeral workspaces. |
| DELETE | `/v1/sandboxes/{id}` | Explicitly discard workspace metadata and its live container. |

IDs match `[a-z0-9][a-z0-9-]{0,62}`. Command request IDs are 32 lowercase hex digits.
A workspace ID is a routing identifier, **not** an authorization boundary. The
bearer token grants access to all workspace IDs in this Worker deployment.

Initialization body:

```json
{"persistent":true,"cwd":"/workspace","image":"hermes","instance":"standard-1"}
```

The image must exist in the deployed named image map. The instance must be in the
operator's allowlist. A changed configuration on an existing workspace is a 409,
not an implicit reimage, resize or data deletion.

Execution body:

```json
{"request_id":"0123456789abcdef0123456789abcdef","command":"printf hello","timeout":30,"login":false,"stdin":null}
```

The command is passed as one argv element to a fixed, root-owned supervisor. No
shell interpolation is performed by the Worker. Bash interprets the command in
the sandbox as intended; this is an arbitrary-code-execution API for its owner.
Standard input is UTF-8 text (NUL is rejected), not base64 or arbitrary bytes.

A successful HTTP 200 response has `Content-Type: application/x-ndjson` and
contains events like these:

```json
{"type":"heartbeat"}
{"type":"started","request_id":"0123456789abcdef0123456789abcdef"}
{"type":"output","data":"hello"}
{"type":"exit","exit_code":0}
```

Startup heartbeats prevent a quiet cold start from being mistaken for an ended
stream. A terminal `exit` event is mandatory for command success. A nonzero exit
is a command result, not a transport error. Stdout/stderr are combined. Source
stream ordering is not guaranteed by the native runtime.

Infrastructure and limit failures produce an `error` event instead of `exit`:

```json
{"type":"error","code":"output_limit"}
```

The HTTP status cannot be changed once a streaming response begins. Clients must
check the terminal event and must not treat partial output as a successful file
read. An interrupted stream without `exit` has an unknown execution outcome.

Non-streaming failures use `{"error":{"code":"...","message":"..."}}` with an
appropriate HTTP status. Server exceptions and tokens are not exposed in errors.

Cancel, release and checkpoint requests send `{}` with JSON content type. Delete
requires `{"confirm":true}`. Deleting metadata discards the stored snapshot handle;
there is no call here to permanently delete Cloudflare's immutable snapshot data.

Requests are not automatically replayed. The DO remembers only the latest 64 exec
request IDs and 64 early-cancel IDs. It is not an unlimited idempotency store or an
exactly-once execution service. Inspect side effects before submitting a new ID
after an uncertain response.

One foreground command or lifecycle transition can be active per workspace.
Conflicting operations return 409. Snapshotting does not freeze background
writers, and snapshots do not contain running processes. Stop application-level
writers before manually checkpointing data that requires consistency.

Background jobs started by a command (`cmd &`, `nohup ... &`) keep running after
the command exits, and do not hold the response open. After the command exits,
output already produced is always delivered; further background output is
collected until it pauses for 0.3 s, for at most 5 s. Redirect background output
to a file if you need all of it. This bounded drain follows openclaw/crabbox.

A command that exceeds `timeout` receives SIGTERM, then SIGKILL 2 s later, across
its process group. If the command still has not ended 15 s after `timeout`, the
Worker stops that process group by request ID and returns `hard_timeout`. The
workspace is kept. The container is destroyed only if that targeted stop cannot
run.
