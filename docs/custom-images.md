# Custom images

A workspace runs the named image chosen when it is created
(`{"image": "<name>"}` in the init body, or `HERMES_CF_IMAGE` in Hermes). The
built-in image is `hermes`. You can add your own images, for example with extra
tools, without changing this repository.

## Contract

The Worker talks to the container only through `exec`. An image must provide:

| Requirement | Why |
| --- | --- |
| `linux/amd64` | Cloudflare Containers run amd64. |
| `/usr/local/bin/hermes-exec` from the same release as the Worker | Runs every command (timeouts, cancellation, output). Without it every command fails to start. |
| `python3` (for `hermes-exec`) and `/bin/bash` | Commands are Bash scripts. |
| `/bin/true`, `/bin/mkdir`, `/bin/sync`, `/usr/bin/stat`, `/usr/bin/cat` | Readiness probe, working directory, snapshot flush, file reads. |
| `base64`, `mktemp`, `realpath`, `find`, `printf` on `PATH` | File tools of the clients. |
| A writable working directory (default `/workspace`) for the image user | Where commands run. |
| A long-running default command (e.g. `sleep infinity`) | The container must stay up between commands. |

The easiest way to meet it is to start from the base image and add to it.
`worker/scripts/check-image.sh IMAGE [CWD]` checks a locally built image
(`CWD` defaults to `/workspace`).

## Start from the base image

The base image is published to GitHub Container Registry by
`.github/workflows/base-image.yml` on each release tag and on `main`:

```dockerfile
# Pin by digest: a changed base replaces new workspaces' contents.
FROM ghcr.io/kiyo-e/hermes-cloudflare-sandbox-base:v0.2.0@sha256:<digest>
USER root
RUN apt-get update && apt-get install -y --no-install-recommends jq \
    && rm -rf /var/lib/apt/lists/*
USER hermes
```

Keep `USER hermes`, `WORKDIR /workspace` and the default command from the base
unless you mean to change them. If you copy `hermes-exec` into another base
image instead, take it from the same release as the Worker you deploy.

Cloudflare cannot pull from GHCR directly. The image is built locally `FROM`
the base and uploaded by `wrangler deploy`.

## Register images

Images are part of the Worker deployment. Do not edit `wrangler.jsonc`; list
your images in a separate file:

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

Always deploy with the same image list. A deploy without it removes those
names from the Worker, and workspaces created with them cannot start again
until they are restored.

## Changing an image

A workspace keeps its image name for life (changing it is a `config_conflict`).
Updating the image behind a name affects only workspaces that boot from the
image later; a workspace restored from a snapshot keeps the files it had. To
move an existing workspace to a new image, delete it and create it again.
