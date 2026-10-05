# Hermes Cloudflare Sandbox

[![Test](https://github.com/kiyo-e/hermes-cloudflare-sandbox/actions/workflows/test.yml/badge.svg)](https://github.com/kiyo-e/hermes-cloudflare-sandbox/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**English** | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

Run the Hermes Agent terminal in a Cloudflare Container: commands, files and `execute_code` run remotely, and the workspace is saved to a snapshot when idle.

A terminal backend plugin for [Hermes Agent](https://github.com/NousResearch/hermes-agent). Each workspace is a Cloudflare Container managed by a Durable Object; Hermes itself stays on your machine or server.

**Status: early.** Tested against a real Cloudflare account and Hermes install (see [VALIDATION.md](VALIDATION.md), in Japanese). It uses Cloudflare's `durable_object` scheduling policy and `ctx.container` API, which are in public beta.

```text
Hermes Agent
  └─ terminal backend: cloudflare_sandbox
       └─ HTTPS + bearer token
            └─ Cloudflare Worker
                 └─ Durable Object (one per workspace)
                      └─ Container: Bash / Python / Node.js, /workspace, snapshots
```

## Features

- Runs Hermes' `terminal`, file tools and `execute_code` in the container.
- Streams UTF-8 output, with stdin, exit codes, timeouts and cancellation.
- Named images and per-workspace instance types.
- Saves an idle workspace to a snapshot and restores it on the next command.

Browser tools, skills, credentials and your home directory stay on the host and are not synced into the container.

## Requirements

- A Hermes version with terminal environment provider plugins
- Python 3.11+, Node.js 22+ and Docker
- A Cloudflare account with Containers. **Running containers is billed.**

## 1. Deploy the Worker

```bash
git clone https://github.com/kiyo-e/hermes-cloudflare-sandbox.git
cd hermes-cloudflare-sandbox/worker
npm ci
npm test
npm run typecheck
npx wrangler login
npm run deploy
```

The Worker rejects every request until a secret is set. Generate one and store it:

```bash
python -c 'import secrets; print(secrets.token_urlsafe(48))'
npx wrangler secret put SANDBOX_API_TOKEN
```

Use the same value as `HERMES_CF_TOKEN` in Hermes. Do not commit it or put it in `wrangler.jsonc` or the container image.

`worker/wrangler.jsonc` sets the image (`hermes`), the default instance type (`standard-1`) and the allowed types (`ALLOWED_INSTANCE_TYPES`). `ENABLE_INTERNET=true` allows outbound traffic for git and package managers; set it to `false` to block it.

## 2. Install the plugin in Hermes

```bash
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins"
git clone https://github.com/kiyo-e/hermes-cloudflare-sandbox.git \
  "${HERMES_HOME:-$HOME/.hermes}/plugins/cloudflare-sandbox"
```

Add these to the profile's `.env` (optional settings are in `.env.sample`):

```dotenv
HERMES_CF_ENDPOINT=https://your-worker.your-subdomain.workers.dev
HERMES_CF_TOKEN=the-secret-you-generated
HERMES_CF_NAMESPACE=personal
HERMES_CF_IMAGE=hermes
```

```bash
hermes plugins enable cloudflare-sandbox
hermes config set terminal.backend cloudflare_sandbox
hermes config set terminal.cwd /workspace
hermes config set terminal.container_persistent true
```

Restart Hermes afterwards. To keep your usual profile on the local terminal, try it in a separate profile first (`hermes profile create <name> --clone`).

## 3. Verify

Run these from the repository root.

```bash
python scripts/check_hermes_contract.py --hermes-source /path/to/hermes-agent
python scripts/smoke.py --live
```

The first command checks that your Hermes has the interfaces this plugin needs. The second needs `HERMES_CF_ENDPOINT` and `HERMES_CF_TOKEN` in the environment; it runs commands, saves and restores a snapshot in a temporary workspace, then deletes the workspace. It is billed like normal use.

## Workspaces and persistence

With `container_persistent: true`, the namespace and Hermes' task ID select the workspace, and its files are kept between sessions. To share one workspace across task IDs or machines, set the same `HERMES_CF_NAMESPACE` and `HERMES_CF_WORKSPACE` (for example `my-project`). Do not use one workspace from several Hermes processes at the same time.

With `container_persistent: false`, the workspace is deleted when the session ends.

When a session ends, or after about 10 minutes without commands (`IDLE_SECONDS` in `wrangler.jsonc`), the workspace is saved to a snapshot and the container stops. If saving fails, the container keeps running and the save is retried.

**Snapshots are not backups.** They contain files only, so running processes (including background jobs) do not survive. Cloudflare deletes a snapshot 30 days after it is created or restored. Keep important work in git.

If a container is lost before any snapshot exists, the Worker returns `workspace_lost` instead of starting an empty workspace. Use a new workspace name.

## Configuration

| Setting | Meaning |
| --- | --- |
| `terminal.container_persistent` | Keep the workspace in snapshots between sessions. |
| `terminal.cwd` | Working directory inside the container. Default `/workspace`. |
| `HERMES_CF_IMAGE` | An image name defined in `wrangler.jsonc`. |
| `HERMES_CF_INSTANCE` | `lite` or `standard-1` to `standard-4`, and also listed in `ALLOWED_INSTANCE_TYPES`. |
| `HERMES_CF_ACCESS_CLIENT_ID`, `HERMES_CF_ACCESS_CLIENT_SECRET` | A Cloudflare Access service token, if the Worker is behind Access. |

Hermes' generic container image, CPU, memory and disk settings are not used.

## Security

The bearer token gives full control: whoever holds it can run any command in every workspace. The bridge is meant for a single owner and has no per-user permissions, concurrency limits or spending caps. If others can reach the Worker, put Cloudflare Access in front of it.

The token is never passed into the container, but anything you write inside the container ends up in snapshots.

Hermes still asks for approval before dangerous commands, so in unattended runs such as `hermes chat -q`, `execute_code` is blocked unless you allow it in Hermes' approval settings or with `--yolo`.

## Limits and behavior

| Item | Limit |
| --- | --- |
| Command string | 64 KiB |
| Request body | 1 MiB |
| Output per command | 2,000,000 characters |
| Run time per command | 900 seconds |

Output over the limit is an error, never a truncated result. stdout and stderr are merged, and stdin must be UTF-8 text.

A command that times out gets SIGTERM, then SIGKILL 2 seconds later. Background jobs (`cmd &`) keep running after the command returns; their output is collected for at most 5 seconds afterwards, so redirect it to a file if you need all of it.

If the connection drops, the command may already have run. Nothing is retried automatically.

The Worker API is described in [docs/protocol.md](docs/protocol.md).

## Development

```bash
python -m pip install -e '.[test]'
python -m pytest -q
cd worker
npm ci
npm test
npm run typecheck
```

## References

- [Hermes terminal environment provider plugins](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/terminal-environment-plugin.md)
- [Cloudflare Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)
- [Cloudflare scheduling policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)
- [Cloudflare snapshots](https://developers.cloudflare.com/containers/guides/snapshots/)

## License

[MIT](LICENSE). Parts of the container supervisor are based on [openclaw/crabbox](https://github.com/openclaw/crabbox) (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
