#!/bin/bash
# Check that a locally built image works as a Hermes terminal backend image
# (docs/custom-images.md). Usage: worker/scripts/check-image.sh IMAGE [CWD]
# CWD is Hermes' terminal.cwd (default /workspace).
#
# Runs what Hermes needs from the image: it stays up between commands, has the
# programs Hermes runs (shell snapshot, file tools, file sync, execute_code),
# runs a command in CWD, and can stop a running command (interrupt/timeout).
set -eu
image=${1:?usage: check-image.sh IMAGE [CWD]}
cwd=${2:-/workspace}
fail() { echo "FAIL: $*" >&2; exit 1; }
# Commands run through the base image's runner, with an id like the plugin's (uuid4().hex).
runner=/usr/local/bin/hermes-exec
command_id() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }

arch=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image") || fail "image not found"
[ "$arch" = linux/amd64 ] || fail "platform is $arch; Cloudflare Containers run linux/amd64"

name=hermes-check-$$
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT INT TERM
docker run -d --platform linux/amd64 --name "$name" "$image" >/dev/null || fail "the image does not start"
sleep 3
[ "$(docker inspect --format '{{.State.Running}}' "$name")" = true ] \
  || fail "the container exits on its own; keep the base image's default command"

docker exec "$name" /bin/bash -c 'test -x "$1"' bash "$runner" \
  || fail "missing /bin/bash or $runner; build FROM the base image"
# rg is optional: Hermes falls back to grep.
docker exec "$name" /bin/bash -c 'for t in awk base64 cat chmod cut find grep head kill ls mkdir mktemp mv od python3 readlink realpath rm sed sha256sum stat tail tar timeout wc; do command -v "$t" >/dev/null || { echo "missing $t" >&2; exit 1; }; done' \
  || fail "missing a program Hermes runs in the sandbox"
docker exec "$name" /bin/bash -c 'for t in /bin/true /bin/sync /usr/bin/stat /usr/bin/cat; do test -x "$t" || { echo "missing $t" >&2; exit 1; }; done' \
  || fail "coreutils must be at the standard paths (/bin, /usr/bin)"

docker exec "$name" /bin/mkdir -p -- "$cwd" || fail "cannot create $cwd"
out=$(docker exec -w "$cwd" "$name" "$runner" --id "$(command_id)" 5 -c \
  'printf ok; : > .hermes-check && stat -c %s .hermes-check && rm .hermes-check') \
  || fail "a command cannot run in $cwd (enter, create, read) as the image user"
[ "$out" = ok0 ] || fail "unexpected command output: $out"

# Stopping a running command. The command waits with a Bash builtin on an open,
# empty stdin, so the check does not depend on `sleep` in the image.
id=$(command_id)
fifo=$(mktemp -u); mkfifo "$fifo"; exec 4<>"$fifo"; rm -f "$fifo"
docker exec -i -w "$cwd" "$name" "$runner" --id "$id" 60 -c 'read -r -t 60 _' <&4 >/dev/null 2>&1 &
launched=$!
sleep 2
kill -0 "$launched" 2>/dev/null || fail "the test command ended before it could be stopped"
docker exec "$name" "$runner" --kill "$id" || fail "stopping a command failed"
for ((i = 0; i < 100; i++)); do kill -0 "$launched" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$launched" 2>/dev/null; then
  kill "$launched" 2>/dev/null || true
  fail "a running command could not be stopped (is /tmp writable?)"
fi

echo "OK: $image works as a Hermes terminal image"
