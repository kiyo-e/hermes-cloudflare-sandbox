#!/bin/bash
# Check that a locally built image meets the custom image contract
# (docs/custom-images.md). Usage: worker/scripts/check-image.sh IMAGE [CWD]
# CWD is the working directory the workspace will use (default /workspace).
#
# Mirrors the Worker (worker/src/service.ts): the container runs the image's
# own default command, and each probe is a separate exec with the argv the
# Worker uses. Request ids are 32 lowercase hex digits, like the ones the
# Hermes plugin (uuid4().hex).
set -eu
image=${1:?usage: check-image.sh IMAGE [CWD]}
cwd=${2:-/workspace}
fail() { echo "FAIL: $*" >&2; exit 1; }
request_id() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }
supervisor=/usr/local/bin/hermes-exec

arch=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image") || fail "image not found"
[ "$arch" = linux/amd64 ] || fail "platform is $arch; Cloudflare Containers run linux/amd64"

# The default command must keep the container up between commands.
name=hermes-check-$$
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT INT TERM
docker run -d --platform linux/amd64 --name "$name" "$image" >/dev/null || fail "the image does not start"
sleep 3
[ "$(docker inspect --format '{{.State.Running}}' "$name")" = true ] \
  || fail "the default command exits; use a long-running one such as sleep infinity"
x() { docker exec "$name" "$@"; }

# Programs the Worker execs directly.
x /bin/true || fail "missing /bin/true (readiness probe)"
x /bin/mkdir -p -- "$cwd" || fail "cannot create $cwd"
x /bin/sync || fail "missing /bin/sync (snapshot flush)"
for tool in "$supervisor" /usr/bin/stat /usr/bin/cat; do
  x /bin/bash -c 'test -x "$1"' bash "$tool" || fail "missing /bin/bash or $tool"
done
# Programs Hermes core runs inside the sandbox (session snapshot, file tools,
# file sync, execute_code). rg is optional: Hermes falls back to grep.
x /bin/bash -c 'for t in awk base64 cat chmod cut find grep head kill ls mkdir mktemp mv od python3 readlink realpath rm sed sha256sum stat tail tar timeout wc; do command -v "$t" >/dev/null || { echo "missing $t" >&2; exit 1; }; done' \
  || fail "missing a program Hermes runs in the sandbox"

# A command exactly as the Worker launches it: --id, timeout, -c, in cwd.
out=$(docker exec -w "$cwd" "$name" "$supervisor" --id "$(request_id)" 5 -c \
  'printf ok; : > .hermes-check && /usr/bin/stat -c %s .hermes-check && rm .hermes-check') \
  || fail "a command cannot run in $cwd (enter, create, read) as the image user"
[ "$out" = ok0 ] || fail "unexpected command output: $out"

# Cancellation by request id (the Worker's fallback when a command will not stop).
id=$(request_id)
# Bash builtin wait on stdin, which stays open and empty (a host FIFO held
# open by this script): no sleep binary required in the image.
fifo=$(mktemp -u); mkfifo "$fifo"; exec 4<>"$fifo"; rm -f "$fifo"
docker exec -i -w "$cwd" "$name" "$supervisor" --id "$id" 60 -c 'read -r -t 60 _' <&4 >/dev/null 2>&1 &
launched=$!
sleep 2
kill -0 "$launched" 2>/dev/null || fail "the cancellation probe command ended before it could be cancelled"
x "$supervisor" --kill "$id" || fail "$supervisor --kill failed"
for _ in $(seq 100); do kill -0 "$launched" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$launched" 2>/dev/null; then
  kill "$launched" 2>/dev/null || true
  fail "--kill did not stop the command (the supervisor must record request ids; is /tmp writable?)"
fi

echo "OK: $image meets the custom image contract"
