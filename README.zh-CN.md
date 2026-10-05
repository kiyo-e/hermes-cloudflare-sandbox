# Hermes Cloudflare Sandbox

[![Test](https://github.com/kiyo-e/hermes-cloudflare-sandbox/actions/workflows/test.yml/badge.svg)](https://github.com/kiyo-e/hermes-cloudflare-sandbox/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | [日本語](README.ja.md) | **简体中文**

在 Cloudflare Container 中运行 Hermes Agent 的 terminal：命令、文件操作和 `execute_code` 都在远程执行，空闲时工作区会保存为 snapshot。

这是 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的 terminal backend 插件。每个工作区对应一个由 Durable Object 管理的 Cloudflare Container；Hermes 本身仍留在你的电脑或服务器上。

**状态：早期阶段。** 已在真实的 Cloudflare 账号和 Hermes 上验证（见 [VALIDATION.md](VALIDATION.md)，日文）。本插件使用 Cloudflare 的 `durable_object` scheduling policy 和 `ctx.container` API，两者目前都处于 public beta。

```text
Hermes Agent
  └─ terminal backend: cloudflare_sandbox
       └─ HTTPS + bearer token
            └─ Cloudflare Worker
                 └─ Durable Object（每个工作区一个）
                      └─ Container: Bash / Python / Node.js、/workspace、snapshot
```

## 功能

- 在容器中运行 Hermes 的 `terminal`、文件工具和 `execute_code`。
- 流式返回 UTF-8 输出，支持标准输入、退出码、超时和取消。
- 支持命名镜像，以及按工作区选择实例类型。
- 把空闲的工作区保存为 snapshot，并在下一条命令时恢复。

浏览器工具、skills、凭据和 home 目录都留在主机上，不会同步到容器中。

## 环境要求

- 支持 terminal environment provider 插件的 Hermes 版本
- Python 3.11 及以上、Node.js 22 及以上、Docker
- 可以使用 Containers 的 Cloudflare 账号。**运行容器会产生费用。**

## 1. 部署 Worker

```bash
git clone https://github.com/kiyo-e/hermes-cloudflare-sandbox.git
cd hermes-cloudflare-sandbox/worker
npm ci
npm test
npm run typecheck
npx wrangler login
npm run deploy
```

在设置 secret 之前，Worker 会拒绝所有请求。生成一个 secret 并注册：

```bash
python -c 'import secrets; print(secrets.token_urlsafe(48))'
npx wrangler secret put SANDBOX_API_TOKEN
```

把同一个值设置为 Hermes 的 `HERMES_CF_TOKEN`。不要把它提交到仓库、写入 `wrangler.jsonc` 或打包进容器镜像。

`worker/wrangler.jsonc` 设置镜像（`hermes`）、默认实例类型（`standard-1`）和允许的类型（`ALLOWED_INSTANCE_TYPES`）。`ENABLE_INTERNET=true` 允许出站访问，以便使用 git 和包管理器；设为 `false` 即可禁止。

## 2. 在 Hermes 中安装插件

```bash
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins"
git clone https://github.com/kiyo-e/hermes-cloudflare-sandbox.git \
  "${HERMES_HOME:-$HOME/.hermes}/plugins/cloudflare-sandbox"
```

把以下内容追加到该 profile 的 `.env`（可选设置见 `.env.sample`）：

```dotenv
HERMES_CF_ENDPOINT=https://your-worker.your-subdomain.workers.dev
HERMES_CF_TOKEN=这里填写你生成的 secret
HERMES_CF_NAMESPACE=personal
HERMES_CF_IMAGE=hermes
```

```bash
hermes plugins enable cloudflare-sandbox
hermes config set terminal.backend cloudflare_sandbox
hermes config set terminal.cwd /workspace
hermes config set terminal.container_persistent true
```

设置完成后请重启 Hermes。如果希望平时使用的 profile 继续使用本地 terminal，请先在单独的 profile（`hermes profile create <名称> --clone`）中试用。

## 3. 验证

请在仓库根目录下运行：

```bash
python scripts/check_hermes_contract.py --hermes-source /path/to/hermes-agent
python scripts/smoke.py --live
```

第一条命令检查你的 Hermes 是否具备本插件需要的接口。第二条命令需要在环境变量中设置 `HERMES_CF_ENDPOINT` 和 `HERMES_CF_TOKEN`；它会在临时工作区中执行命令、保存并恢复 snapshot，最后删除该工作区。它和正常使用一样会产生费用。

## 工作区与持久化

当 `container_persistent: true` 时，由 namespace 和 Hermes 的 task ID 决定工作区，文件会在会话之间保留。要在不同的 task ID 或不同的机器之间共用一个工作区，请设置相同的 `HERMES_CF_NAMESPACE` 和 `HERMES_CF_WORKSPACE`（例如 `my-project`）。不要让多个 Hermes 进程同时使用同一个工作区。

当 `container_persistent: false` 时，会话结束时会删除工作区。

会话结束时，或大约 10 分钟没有命令时（可通过 `wrangler.jsonc` 中的 `IDLE_SECONDS` 修改），工作区会保存为 snapshot，然后容器停止。如果保存失败，容器会继续运行，并重试保存。

**snapshot 不能替代备份。** 它只包含文件，因此正在运行的进程（包括后台进程）不会保留。Cloudflare 会在 snapshot 创建或恢复 30 天后删除它。重要的成果请保存到 git。

如果容器在还没有任何 snapshot 时丢失，Worker 不会创建空的工作区，而是返回 `workspace_lost`。请使用新的工作区名称。

## 配置

| 设置 | 含义 |
| --- | --- |
| `terminal.container_persistent` | 在会话之间用 snapshot 保留工作区。 |
| `terminal.cwd` | 容器内的工作目录，默认是 `/workspace`。 |
| `HERMES_CF_IMAGE` | 在 `wrangler.jsonc` 中定义的镜像名称。 |
| `HERMES_CF_INSTANCE` | `lite` 或 `standard-1` 至 `standard-4`，且需在 `ALLOWED_INSTANCE_TYPES` 中允许。 |
| `HERMES_CF_ACCESS_CLIENT_ID`、`HERMES_CF_ACCESS_CLIENT_SECRET` | Worker 受 Cloudflare Access 保护时使用的 service token。 |

Hermes 通用的容器镜像、CPU、内存和磁盘设置不会被使用。

## 安全

持有 bearer token 的人可以在所有工作区中执行任意命令。这个 bridge 面向单个所有者，没有按用户的权限、并发限制或费用上限。如果其他人能访问到 Worker，请用 Cloudflare Access 保护它。

token 不会传入容器，但你在容器中写入的文件也会进入 snapshot。

Hermes 对危险命令的审批仍然有效。因此在 `hermes chat -q` 这类无人值守的运行中，除非在 Hermes 的审批设置中允许或使用 `--yolo`，否则 `execute_code` 会被拦截。

## 限制与行为

| 项目 | 上限 |
| --- | --- |
| 命令字符串 | 64 KiB |
| 请求体 | 1 MiB |
| 每条命令的输出 | 2,000,000 个字符 |
| 每条命令的运行时间 | 900 秒 |

输出超过上限时会报错，绝不会返回截断的结果。stdout 和 stderr 会合并返回，标准输入必须是 UTF-8 文本。

超时的命令会先收到 SIGTERM，2 秒后收到 SIGKILL。后台进程（`cmd &`）在命令返回后会继续运行；之后最多只等待其输出 5 秒，如需全部输出请重定向到文件。

连接中断时，命令可能已经执行。不会自动重试。

Worker 的 API 见 [docs/protocol.md](docs/protocol.md)（英文）。

## 开发

```bash
python -m pip install -e '.[test]'
python -m pytest -q
cd worker
npm ci
npm test
npm run typecheck
```

## 参考资料

- [Hermes terminal environment provider plugins](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/terminal-environment-plugin.md)
- [Cloudflare Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)
- [Cloudflare scheduling policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)
- [Cloudflare snapshots](https://developers.cloudflare.com/containers/guides/snapshots/)

## 许可证

[MIT](LICENSE)。容器内 supervisor 的部分代码基于 [openclaw/crabbox](https://github.com/openclaw/crabbox)（MIT），详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
