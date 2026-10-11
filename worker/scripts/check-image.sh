#!/bin/sh
# Check that a locally built image meets the custom image contract
# (docs/custom-images.md). Usage: worker/scripts/check-image.sh IMAGE
# The Worker execs programs directly, bypassing ENTRYPOINT, so this does too.
set -eu
image=${1:?usage: check-image.sh IMAGE}
fail() { echo "FAIL: $*" >&2; exit 1; }
x() { program=$1; shift; docker run --rm --platform linux/amd64 --entrypoint "$program" "$image" "$@"; }
arch=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image") || fail "image not found"
[ "$arch" = linux/amd64 ] || fail "platform is $arch; Cloudflare Containers run linux/amd64"
x /usr/bin/test -x /usr/local/bin/hermes-exec 2>/dev/null || fail "missing /usr/local/bin/hermes-exec"
for tool in /bin/bash /bin/true /bin/mkdir /bin/sync /usr/bin/stat /usr/bin/cat; do
  x /usr/bin/test -x "$tool" || fail "missing $tool"
done
x /bin/bash -c 'for t in base64 mktemp realpath find printf python3; do command -v "$t" >/dev/null || { echo "missing $t"; exit 1; }; done' \
  || fail "missing a tool used by file operations"
[ "$(x /usr/local/bin/hermes-exec 5 -c 'printf ok')" = ok ] || fail "supervisor cannot run bash"
x /bin/sh -c 'mkdir -p /workspace && test -w /workspace' || fail "/workspace is not writable by the image user"
echo "OK: $image meets the custom image contract"
