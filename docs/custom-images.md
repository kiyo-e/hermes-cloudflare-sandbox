# Custom images

Hermes runs its terminal in the image named by `HERMES_CF_IMAGE` (default
`hermes`, the built-in image). You can add your own images, for example with
extra tools, without changing this repository. Nothing changes for existing
setups: `hermes` stays the default and is never replaced.

## What Hermes needs from an image

Build `FROM` the base image (below) and add to it. The base image provides
everything Hermes needs:

| Requirement | Why |
| --- | --- |
| `linux/amd64` | Cloudflare Containers run only this platform. |
| The base image's default command | The container stays up between Hermes commands. |
| `/usr/local/bin/hermes-exec` and `python3` | Runs each terminal command, applies its timeout, and stops it on interrupt. |
| Bash, GNU coreutils, `grep`, `sed`, `awk`, `find`, `tar` | Hermes' shell snapshot, file read/write/patch, and file sync. |
| `python3` | `execute_code`. |
| `terminal.cwd` (default `/workspace`) that the image user can enter and write | Where commands run. |

Hermes uses `rg` (ripgrep) for search when present and falls back to `grep`.

`worker/scripts/check-image.sh IMAGE [CWD]` checks a locally built image
(`CWD` is your `terminal.cwd`, default `/workspace`).

## Start from the base image

The base image is published to GitHub Container Registry by
`.github/workflows/base-image.yml` on each release tag and on `main`.
GitHub creates a new package as private: after the first publish, set the
`hermes-cloudflare-sandbox-base` package to public in its package settings, or
run `docker login ghcr.io` before building. Forks publish under their own
owner name.

```dockerfile
# Pin by digest: a changed base replaces new workspaces' contents.
FROM ghcr.io/kiyo-e/hermes-cloudflare-sandbox-base:v0.2.0@sha256:<digest>
USER root
RUN apt-get update && apt-get install -y --no-install-recommends jq \
    && rm -rf /var/lib/apt/lists/*
USER hermes
```

Keep `USER hermes`, `WORKDIR /workspace` and the default command from the base
unless you mean to change them. Use the base image from the same release as
the plugin.

Cloudflare cannot pull from GHCR directly. The image is built locally `FROM`
the base and uploaded when you deploy.

## Register images

Images are deployed together with the sandbox. Do not edit `wrangler.jsonc`;
list your images in a separate file:

```json
{
  "tools": { "dockerfile": "./tools/Dockerfile" },
  "prebuilt": { "image": "registry.cloudflare.com/<account>/<repo>@sha256:<digest>" }
}
```

- `dockerfile` (with optional `build_context`, `build_vars`) is built by
  Wrangler. Relative paths are resolved from the JSON file's directory.
- `image` must be a digest-pinned reference in the Cloudflare registry
  (`wrangler containers push`). Other registries are not accepted.
- `hermes` and `__proto__` cannot be used. Names match `[A-Za-z0-9_-]{1,128}`.

Then deploy from `worker/`:

```bash
node scripts/with-images.mjs /path/to/images.json   # writes worker/wrangler.generated.jsonc
npx wrangler deploy --config wrangler.generated.jsonc
```

Then set `HERMES_CF_IMAGE=tools` (the name in the file) in the Hermes
profile's `.env`.

Always deploy with the same image list. A deploy without it removes those
images, and workspaces created with them cannot start again until they are
restored.

## Changing an image

A workspace keeps its image for life: changing `HERMES_CF_IMAGE` for an
existing workspace is refused.
Updating the image behind a name affects only workspaces that boot from the
image later; a workspace restored from a snapshot keeps the files it had. To
move an existing workspace to a new image, delete it and create it again.
