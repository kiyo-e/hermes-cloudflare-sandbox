#!/bin/sh
# Check that a locally built image meets the custom image contract
# (docs/custom-images.md). Usage: worker/scripts/check-image.sh IMAGE [CWD]
# CWD is the working directory the workspace will use (default /workspace).
# The Worker execs programs directly, bypassing ENTRYPOINT, so this does too.
set -eu
image=${1:?usage: check-image.sh IMAGE [CWD]}
cwd=${2:-/workspace}
fail() { echo "FAIL: $*" >&2; exit 1; }
x() { program=$1; shift; docker run --rm --platform linux/amd64 --entrypoint "$program" "$image" "$@"; }
arch=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image") || fail "image not found"
[ "$arch" = linux/amd64 ] || fail "platform is $arch; Cloudflare Containers run linux/amd64"
x /bin/bash -c 'test -x "$1"' bash /usr/local/bin/hermes-exec 2>/dev/null || fail "missing /bin/bash or /usr/local/bin/hermes-exec"
for tool in /bin/true /bin/mkdir /bin/sync /usr/bin/stat /usr/bin/cat; do
  x /bin/bash -c 'test -x "$1"' bash "$tool" || fail "missing $tool"
done
x /bin/bash -c 'for t in base64 mktemp realpath find printf python3; do command -v "$t" >/dev/null || { echo "missing $t"; exit 1; }; done' \
  || fail "missing a tool used by file operations"
# Like the Worker: with a request id, so the supervisor must record it for --kill.
id=0123456789abcdef0123456789abcdef
x /bin/bash -c '
  /usr/local/bin/hermes-exec --id "$1" 30 -c "sleep 30" & sup=$!
  for _ in $(seq 50); do test -e "${HERMES_EXEC_STATE_DIR:-/tmp/hermes-exec}/$1" && break; sleep 0.1; done
  test -e "${HERMES_EXEC_STATE_DIR:-/tmp/hermes-exec}/$1" || { echo "no state file"; exit 1; }
  /usr/local/bin/hermes-exec --kill "$1" || exit 1
  wait "$sup"; test "$(/usr/local/bin/hermes-exec 5 -c "printf ok")" = ok' bash "$id" \
  || fail "supervisor cannot run, record or cancel a command (is /tmp writable?)"
x /bin/bash -c '/bin/mkdir -p -- "$1" && cd -- "$1" && : > .hermes-check && /usr/bin/stat -c %s .hermes-check >/dev/null && rm -f .hermes-check' bash "$cwd" || fail "$cwd is not usable (enter, create, read) by the image user"
# The default command must keep the container up between commands.
name=hermes-check-$$
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT INT TERM
docker run -d --rm --platform linux/amd64 --name "$name" "$image" >/dev/null || fail "the image does not start"
sleep 3
running=$(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null || echo false)
docker rm -f "$name" >/dev/null 2>&1 || true
[ "$running" = true ] || fail "the default command exits; use a long-running one such as sleep infinity"
echo "OK: $image meets the custom image contract"
