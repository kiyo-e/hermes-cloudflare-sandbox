# Hermes Cloudflare Sandbox

[English](README.md) | [日本語](README.ja.md) | **简体中文**

这是一个第三方插件，把 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的 terminal backend 放到由 Cloudflare Durable Object 管理的 Container 中运行。Hermes 本身仍留在你的电脑或服务器上，只有命令执行被转移到 Cloudflare。

**状态：早期实现。** 已在真实的 Cloudflare 账号和真实的 Hermes 上验证了基本操作。具体测试范围见 [VALIDATION.md](VALIDATION.md)（日文）。本项目不是 Hermes 或 Cloudflare 的官方插件。

本插件面向 2026 年 9 月 30 日发布的 `durable_object` scheduling policy 和原生 `ctx.container` API，不依赖旧的 `Container` 类或旧版 `Sandbox` 类。这些 Cloudflare 功能目前处于 public beta，请在自己的账号中确认兼容性。

```text
Hermes Agent
  └─ TerminalEnvironmentProvider: cloudflare_sandbox
       └─ BaseEnvironment / streaming ProcessHandle
            └─ HTTPS + bearer token
                 └─ Cloudflare Worker
                      └─ HermesSandbox Durable Object
                           └─ ctx.container
                                ├─ 非 root 的 Bash / Python / Node.js
                                ├─ /workspace
                                └─ filesystem snapshot / restore
```

## 功能

- 作为 Hermes 官方的 terminal environment provider 注册。
- 带认证的执行 API：支持标准输入、UTF-8 流式输出、退出码、执行时间限制和取消。
- 支持命名镜像，以及按工作区选择实例类型。
- 支持工作区 snapshot 的保存与恢复。空闲的工作区会先由 Durable Object 的 alarm 保存，再停止。
- 在我们的测试中，启动或恢复工作区会让第一条命令多花约 1–2 秒。

命令包装、CWD 跟踪和 shell snapshot 都交给 Hermes 自身的 `BaseEnvironment` 处理，没有额外叠加 tmux。这并不会永久保持同一个 Bash PID 或内存中的状态，shell state 能延续多少取决于你使用的 Hermes 版本。

本插件接管 `terminal`、文件工具和 `execute_code`。它不会把 Hermes 的其他部分（浏览器、其他外部工具）移到 Cloudflare，也不会把主机的 home 目录、skills 或凭据同步到容器中。

## 环境要求

- 提供 `TerminalEnvironmentProvider` 和 `BaseEnvironment._run_bash()` 的 Hermes 版本。
- Python 3.11 及以上、Node.js 22 及以上、Docker。
- 可以使用新版 Containers API 的 Cloudflare 账号。**运行容器会产生费用。**

Worker 的依赖（Wrangler 4 和 TypeScript）由 `worker/package-lock.json` 固定版本。请用 `npm ci` 安装，并在部署前运行真实的类型生成和类型检查。

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

`npm run typecheck` 会运行 `wrangler types`，并用 Cloudflare 的真实类型检查 production entry point。如果找不到新的 scheduling policy 或 `ctx.container.exec()` 的类型，请更新 Wrangler 并确认 Cloudflare 功能的可用状态，不要改用旧版 SDK。

首次部署后还没有设置 secret，因此 Worker 会拒绝所有 API 请求。生成一个新的随机 secret，并注册为 Worker secret：

```bash
python -c 'import secrets; print(secrets.token_urlsafe(48))'
npx wrangler secret put SANDBOX_API_TOKEN
```

在提示符处粘贴生成的值。之后要把同一个值设置为 Hermes 的 `HERMES_CF_TOKEN`。不要把 secret 提交到仓库、写入 `wrangler.jsonc` 或打包进容器镜像，也不要把 Cloudflare 账号的 API token 挪作此用。

`worker/wrangler.jsonc` 配置了基于 SQLite 的 Durable Object、新的 scheduling policy 和名为 `hermes` 的镜像。默认实例类型是 `standard-1`，只允许 `lite` 和 `standard-1`。如需其他规格，由管理员修改 `ALLOWED_INSTANCE_TYPES`。不要添加旧 policy 使用的 `max_instances` 或 `instance_type`。

`ENABLE_INTERNET=true` 显式允许出站访问，以便使用 git 和包管理器。要禁止出站访问，请改为 `false` 并重新部署。

## 2. 在 Hermes 中安装插件

把本仓库克隆到你要使用的 Hermes profile 的 `plugins` 目录中：

```bash
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins"
git clone https://github.com/kiyo-e/hermes-cloudflare-sandbox.git \
  "${HERMES_HOME:-$HOME/.hermes}/plugins/cloudflare-sandbox"
```

把以下内容追加到 Hermes 进程的环境变量，或该 profile 的 `.env` 中。请追加，不要覆盖已有的 `.env`。可选设置见 `.env.example`。

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

**插件名是 `cloudflare-sandbox`，backend 名是 `cloudflare_sandbox`。** 修改配置后请重启 Hermes。

Python 客户端不需要额外的依赖包。只运行 `pip install` 并不会把插件注册到 Hermes，请按上面的目录结构放置并使用 `hermes plugins enable`。建议先在专用的 profile（`hermes profile create <名称> --clone`）中试用，这样平时使用的 profile 仍然使用本地 terminal。

## 3. 在实际环境中验证

首先，在运行 Hermes 的 Python 环境中检查实际的接口：

```bash
python scripts/check_hermes_contract.py --hermes-source /path/to/hermes-agent
```

然后，在已导出 Worker 地址和 token 的 shell 中，用一个新的工作区运行在线冒烟测试：

```bash
python scripts/smoke.py --live
```

该脚本会检查认证、标准输入、非 ASCII 文本、非零退出码、超时、保存文件、停止以及从 snapshot 恢复。它会创建临时的容器和 snapshot，可能产生费用。它不会使用你的 `HERMES_CF_WORKSPACE`。测试结束时会删除测试用的工作区，但 Cloudflare 可能会保留 snapshot 数据直到 TTL 到期。

最后，请从 Hermes 中检查 `pwd`、文件的写入和读取以及 `execute_code`，并确认你所用的 Hermes 版本中 shell state 的延续情况。

## 工作区的标识与持久化

当 `container_persistent: true` 时，namespace 和 task ID 会被哈希成一个固定的 Durable Object。如果要从不同的 task ID 打开同一个项目，请设置固定的工作区，例如 `HERMES_CF_WORKSPACE=my-project`。不设置时，每个新的 task ID 都会得到独立的工作区。

如果没有设置 namespace，插件会使用该 profile 的 Hermes home。要从另一台机器连接同一个工作区，请显式设置相同的 namespace、workspace 和 Worker 地址。不要让多个 Hermes 进程同时使用同一个固定工作区。Worker 会拒绝并发的前台命令，但不会在多个客户端之间共享或协调 shell state。

当 `container_persistent: false` 时，每个环境都会使用随机标识。退出时会删除容器和 Durable Object 中的记录，不会创建 snapshot。

持久化工作区的释放顺序是：`sync`、创建 snapshot、把 handle 保存到 Durable Object storage、停止容器。如果 snapshot 或 handle 无法保存，会返回错误，容器保持运行，并由 alarm 重试保存。默认情况下，最后一条命令之后约 10 分钟也会执行同样的保存。更长的原生 inactivity timeout 只是最终的停止手段（包括保存失败的情况），并不保证完成保存。

**snapshot 不能替代备份。** 它只保存文件系统，不包括正在运行的进程、内存、外部服务或另外挂载的存储。因此，后台进程不会跨越保存和停止继续运行。按照 Cloudflare 的规定，snapshot 在创建或恢复 30 天后过期，并且与生成它的镜像绑定；更新镜像不会更新从已有 snapshot 恢复的环境。需要长期保留的成果请另存到 git 等位置。

发生崩溃或强制停止时，最后一次成功 snapshot 之后的修改可能会丢失。如果容器在首次启动后、尚无 snapshot 时丢失，Worker 不会悄悄启动一个空的替代环境，而是返回 `workspace_lost`。请排查原因，然后使用新的工作区名称。

## 配置范围与限制

| 设置 / 功能 | 本插件中的处理 |
| --- | --- |
| `terminal.container_persistent` | 开启或关闭基于 snapshot 的持久化。 |
| `terminal.cwd` | 容器内的绝对路径，默认是 `/workspace`。 |
| `HERMES_CF_IMAGE` | 通过 `wrangler.jsonc` 部署的命名镜像。 |
| `HERMES_CF_INSTANCE` | 管理员允许的 Cloudflare 实例类型。 |
| Hermes 通用的 image / CPU / 内存 / 磁盘设置 | 不会自动转换，请使用上面的专用设置。 |
| 主机的环境变量和 home 目录 | 不会转发或同步到容器中。 |
| Cloudflare Access | 可以通过 HTTP 头发送 client ID 和 client secret。不包括创建 Access policy。 |

这个 bridge 面向单个可信的所有者。持有 bearer token 的人可以执行任意 shell 命令，并操作所有工作区；工作区名称不是授权边界。本项目不包含按用户的授权、全局并发限制或费用上限。如果要公开 Worker，请加上 Cloudflare Access 等访问控制，以及运维层面的使用限制。

必须使用 HTTPS，并拒绝重定向；普通 HTTP 只在本地测试的 loopback 上接受。token 只保存在 Worker 和 Hermes 一侧，不会传入容器。写入容器文件的内容也会进入 snapshot，因此请尽量少在其中存放机密信息。本插件有意保留 Hermes 对危险命令的审批，所以在 `hermes chat -q` 这类无人值守的运行中，除非通过配置或 `--yolo` 允许，否则 `execute_code` 会被拦截。

限制：每条命令字符串 64 KiB、每个请求 1 MiB、输出按 JavaScript 字符串长度计 2,000,000 个单位、每条命令最长 900 秒。标准输入必须是不含 NUL 字符的 UTF-8 文本；大文件请分块或使用其他传输方式。输出超过上限时会报错，绝不会把截断的数据当作完整文件内容返回。stdout 和 stderr 会合并返回。

连接中断时命令可能已经执行，因此不会自动重试。Worker 会记录最近 64 个 request ID，并拒绝重放相同的 ID，但这并不是无限期的 exactly-once 保证。出错后请检查副作用。

超时和取消由容器内的 supervisor 处理，它向 Bash 的 process group 发送信号：先发送 SIGTERM，2 秒后发送 SIGKILL。如果命令在超时 15 秒后仍未结束，Worker 会按 request ID 停止该命令的 process group，并保留工作区；只有在这种定向停止本身无法执行时，才会销毁容器。后台进程（`cmd &`）在命令返回后会继续运行，不会阻塞响应。supervisor 用于资源管理，不是针对故意逃离其 process group 的代码的安全边界。输出排空的设计参考了 [openclaw/crabbox](https://github.com/openclaw/crabbox)（MIT）。

## 开发与测试

```bash
python -m pip install -e '.[test]'
python -m pytest -q
cd worker
npm ci
npm test
npm run typecheck
```

Worker 的单元测试使用容器和 Durable Object storage 的测试替身。`npm test` 也会编译核心 TypeScript，但不会用 Cloudflare 的真实类型检查 production entry point；这部分请使用 `npm run typecheck` 和在线测试。

GitHub Actions 会运行 Python 测试、Worker 测试、Wrangler 类型生成与类型检查，以及 Docker 的构建和启动检查。它不会部署，也不持有 Cloudflare 凭据。

## 参考的官方接口

- [Hermes Terminal Environment Provider Plugins](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/terminal-environment-plugin.md)
- [Hermes BaseEnvironment](https://github.com/NousResearch/hermes-agent/blob/main/tools/environments/base.py)
- [Cloudflare Faster Agent Sandboxes](https://blog.cloudflare.com/faster-agent-sandboxes/)
- [Cloudflare Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)
- [Cloudflare Scheduling Policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)
- [Cloudflare Snapshots](https://developers.cloudflare.com/containers/guides/snapshots/)

本项目不是 Hermes 或 Cloudflare 的官方插件。
