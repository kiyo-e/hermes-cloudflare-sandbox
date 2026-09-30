# Hermes Cloudflare Sandbox

**English** | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

A third-party plugin that runs the [Hermes Agent](https://github.com/NousResearch/hermes-agent) terminal backend inside a Cloudflare Container managed by a Durable Object. Hermes itself stays on your machine or server; only command execution moves to Cloudflare.

**Status: early implementation.** The basic operations have been verified against a real Cloudflare account and a real Hermes install. See [VALIDATION.md](VALIDATION.md) for exactly what was tested. This is not an official Hermes or Cloudflare plugin.

It targets the `durable_object` scheduling policy and the native `ctx.container` API released on 2026-09-30. It does not depend on the older `Container` class or the legacy `Sandbox` class. These Cloudflare features are in public beta, so check compatibility in your own account.

```text
Hermes Agent
  └─ TerminalEnvironmentProvider: cloudflare_sandbox
       └─ BaseEnvironment / streaming ProcessHandle
            └─ HTTPS + bearer token
                 └─ Cloudflare Worker
                      └─ HermesSandbox Durable Object
                           └─ ctx.container
                                ├─ non-root Bash / Python / Node.js
                                ├─ /workspace
                                └─ filesystem snapshot / restore
```

## Features

- Registers as an official Hermes terminal environment provider.
- Authenticated execution API with stdin, streamed UTF-8 output, exit codes, time limits and cancellation.
- Named images and per-workspace instance types.
- Workspace snapshots and restore. An idle workspace is checkpointed by a Durable Object alarm, then stopped.
- In our tests, starting or restoring a workspace added about 1–2 seconds to the first command.

Command wrapping, CWD tracking and shell snapshots are delegated to Hermes' own `BaseEnvironment`; there is no extra tmux layer. This does not keep the same Bash PID or in-memory state forever. How much shell state carries over depends on your Hermes version.

The plugin connects `terminal`, file tools and `execute_code`. It does not move the rest of Hermes (the browser, other external tools) into Cloudflare, and it does not sync your host home directory, skills or credentials into the container.

## Requirements

- A Hermes version that provides `TerminalEnvironmentProvider` and `BaseEnvironment._run_bash()`.
- Python 3.11+, Node.js 22+ and Docker.
- A Cloudflare account with access to the new Containers API. **Running containers is billed.**

Worker dependencies (Wrangler 4 and TypeScript) are pinned by `worker/package-lock.json`. Install them with `npm ci`, and run the real type generation and type check before deploying.

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

`npm run typecheck` runs `wrangler types` and checks the production entry point against Cloudflare's real types. If the new scheduling policy or `ctx.container.exec()` types are missing, update Wrangler and check your Cloudflare features; do not switch to an older SDK.

Right after the first deploy no secret is set, so the Worker rejects every API call. Generate a new random secret and store it as a Worker secret:

```bash
python -c 'import secrets; print(secrets.token_urlsafe(48))'
npx wrangler secret put SANDBOX_API_TOKEN
```

Paste the generated value at the prompt. You will set the same value as `HERMES_CF_TOKEN` for Hermes. Never commit the secret, put it in `wrangler.jsonc` or bake it into the container image, and do not reuse a Cloudflare account API token for this purpose.

`worker/wrangler.jsonc` configures a SQLite-backed Durable Object, the new scheduling policy and a named image `hermes`. The default instance type is `standard-1`; only `lite` and `standard-1` are allowed. To allow other sizes, the operator changes `ALLOWED_INSTANCE_TYPES`. Do not add the old policy's `max_instances` or `instance_type`.

`ENABLE_INTERNET=true` explicitly allows outbound traffic so that git and package managers work. Set it to `false` and redeploy to block outbound access.

## 2. Install the plugin in Hermes

Clone this repository into the `plugins` directory of the Hermes profile you want to use:

```bash
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins"
git clone https://github.com/kiyo-e/hermes-cloudflare-sandbox.git \
  "${HERMES_HOME:-$HOME/.hermes}/plugins/cloudflare-sandbox"
```

Add the following to the environment of the Hermes process or to that profile's `.env`. Append; do not overwrite an existing `.env`. Optional settings are listed in `.env.example`.

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

**The plugin name is `cloudflare-sandbox`; the backend name is `cloudflare_sandbox`.** Restart Hermes after changing the configuration.

The Python client needs no extra packages. `pip install` alone does not register the plugin with Hermes; use the directory layout and `hermes plugins enable` shown above. Consider trying it in a dedicated profile first (`hermes profile create <name> --clone`), so your usual profile keeps its local terminal.

## 3. Verify in your environment

First, check the interfaces of the Hermes you are running, from its Python environment:

```bash
python scripts/check_hermes_contract.py --hermes-source /path/to/hermes-agent
```

Then, in a shell with the Worker endpoint and token exported, run the live smoke test against a fresh workspace:

```bash
python scripts/smoke.py --live
```

It checks authentication, stdin, non-ASCII text, non-zero exit codes, timeouts, saving files, stopping, and restoring from a snapshot. It creates a temporary container and snapshot, which may be billed. It never uses your `HERMES_CF_WORKSPACE`. The test workspace is deleted at the end, but Cloudflare may keep the snapshot data until its TTL.

Finally, from Hermes, check `pwd`, writing and reading a file, and `execute_code`, and check how shell state carries over in your Hermes version.

## Workspace identity and persistence

With `container_persistent: true`, the namespace and the task ID are hashed into a stable Durable Object. To reach the same project from a different task ID, set a fixed workspace, for example `HERMES_CF_WORKSPACE=my-project`. Without it, each new task ID gets its own workspace.

If no namespace is set, the plugin uses the Hermes home of the profile. To reach the same workspace from another machine, set the same namespace, workspace and Worker endpoint explicitly. Do not use one fixed workspace from several Hermes processes at the same time. The Worker rejects concurrent foreground commands, but it does not share or reconcile shell state between clients.

With `container_persistent: false`, every environment gets a random identifier. On exit, the container and the Durable Object's records are deleted, and no snapshot is taken.

A persistent workspace is released in this order: `sync`, create a snapshot, store its handle in Durable Object storage, then stop the container. If the snapshot or the handle cannot be saved, the error is returned, the container keeps running, and an alarm retries the save. By default the same save runs after about 10 minutes without commands. A longer native inactivity timeout is only a last-resort stop, including when saving fails; it does not guarantee a save.

**Snapshots are not backups.** They contain the filesystem only, not running processes, memory, external services or separately mounted storage. Background jobs therefore do not survive a checkpoint. Cloudflare expires snapshots 30 days after they are created or restored, and a snapshot is tied to the image it came from; updating the image does not update environments restored from existing snapshots. Keep anything you need long term in git or other storage.

After a crash or a forced stop, changes since the last successful snapshot may be lost. If a container is lost after its first start with no snapshot, the Worker does not silently start an empty replacement; it returns `workspace_lost`. Investigate, then use a new workspace name.

## Configuration scope and limits

| Setting / feature | Behavior in this plugin |
| --- | --- |
| `terminal.container_persistent` | Turns snapshot-based persistence on or off. |
| `terminal.cwd` | An absolute path inside the container. Defaults to `/workspace`. |
| `HERMES_CF_IMAGE` | A named image deployed through `wrangler.jsonc`. |
| `HERMES_CF_INSTANCE` | A Cloudflare instance type allowed by the operator. |
| Hermes' generic image / CPU / memory / disk settings | Not translated. Use the settings above. |
| Host environment variables and home directory | Not forwarded or synced into the container. |
| Cloudflare Access | A client ID and secret can be sent as HTTP headers. Creating the Access policy is not included. |

This bridge is for a single trusted owner. Anyone holding the bearer token can run any shell command and operate on every workspace; workspace names are not an authorization boundary. Per-user authorization, global concurrency limits and spending caps are not included. If you expose the Worker, add access control such as Cloudflare Access and operational usage limits.

HTTPS is required and redirects are refused; plain HTTP is only accepted on loopback for local tests. The token lives in the Worker and in Hermes and is never passed into the container. Anything written to files in the container ends up in snapshots, so keep secrets there to a minimum. Hermes' approval prompts for dangerous commands are deliberately left on, so in unattended runs such as `hermes chat -q`, `execute_code` is blocked unless you approve it by configuration or `--yolo`.

Limits: 64 KiB per command string, 1 MiB per request, 2,000,000 JavaScript string units of output, and 900 seconds per command. stdin is UTF-8 text without NUL characters; split large files or use another transfer method. Output over the limit is an error; truncated data is never returned as if it were the full file. stdout and stderr are merged.

If the connection drops, the command may already have run, so nothing is retried automatically. The Worker remembers the last 64 request IDs and rejects a replay of the same ID, but this is not an unlimited exactly-once guarantee. Check for side effects after an error.

Timeouts and cancellation are handled by a supervisor inside the container that signals Bash's process group: SIGTERM, then SIGKILL 2 seconds later. If a command still has not ended 15 seconds after its timeout, the Worker stops that command's process group by request ID and keeps the workspace; the container is destroyed only if that targeted stop cannot run. Background jobs (`cmd &`) keep running after the command returns and do not hold the response open. The supervisor is resource management, not a security boundary against code that deliberately escapes its process group. The output-draining design follows [openclaw/crabbox](https://github.com/openclaw/crabbox) (MIT).

## Development and tests

```bash
python -m pip install -e '.[test]'
python -m pytest -q
cd worker
npm ci
npm test
npm run typecheck
```

The Worker unit tests use test doubles for the container and Durable Object storage. `npm test` also compiles the core TypeScript, but it does not check the production entry point against Cloudflare's real types; run `npm run typecheck` and the live test for that.

GitHub Actions runs the Python tests, the Worker tests, Wrangler type generation and type check, and a Docker build and start check. It never deploys and holds no Cloudflare credentials.

## Official interfaces referenced

- [Hermes Terminal Environment Provider Plugins](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/terminal-environment-plugin.md)
- [Hermes BaseEnvironment](https://github.com/NousResearch/hermes-agent/blob/main/tools/environments/base.py)
- [Cloudflare Faster Agent Sandboxes](https://blog.cloudflare.com/faster-agent-sandboxes/)
- [Cloudflare Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)
- [Cloudflare Scheduling Policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)
- [Cloudflare Snapshots](https://developers.cloudflare.com/containers/guides/snapshots/)

This project is not an official plugin of Hermes or Cloudflare.
