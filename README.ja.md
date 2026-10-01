# Hermes Cloudflare Sandbox

[![Test](https://github.com/kiyo-e/hermes-cloudflare-sandbox/actions/workflows/test.yml/badge.svg)](https://github.com/kiyo-e/hermes-cloudflare-sandbox/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | **日本語** | [简体中文](README.zh-CN.md)

Hermes Agentのterminalを、CloudflareのContainerで動かします。
コマンド、ファイル操作、`execute_code`がリモートで動き、使わないあいだのワークスペースはsnapshotに保存されます。

[Hermes Agent](https://github.com/NousResearch/hermes-agent)用のterminal backendプラグインです。
ワークスペースごとに、Durable Objectが管理するCloudflareのContainerを使います。
Hermes本体は、手元の環境やサーバーに残ります。

**ステータス：初期段階です。**
実際のCloudflareアカウントとHermesで確認しています（[VALIDATION.md](VALIDATION.md)）。
Cloudflareの`durable_object` scheduling policyと`ctx.container` APIを使っており、どちらもpublic betaです。

```text
Hermes Agent
  └─ terminal backend: cloudflare_sandbox
       └─ HTTPS + bearer token
            └─ Cloudflare Worker
                 └─ Durable Object（ワークスペースごとに1つ）
                      └─ Container: Bash / Python / Node.js、/workspace、snapshot
```

## 機能

- Hermesの`terminal`、ファイル操作、`execute_code`をContainerの中で動かします。
- UTF-8の出力を逐次返します。標準入力、終了コード、タイムアウト、キャンセルに対応します。
- 名前付きイメージと、ワークスペースごとのインスタンスの種類を選べます。
- 使わないあいだのワークスペースをsnapshotに保存し、次のコマンドで復元します。

ブラウザー操作、skills、認証情報、ホームディレクトリは手元に残り、Containerへは同期しません。

## 必要な環境

- terminal environment providerのプラグインに対応したHermes
- Python 3.11以上、Node.js 22以上、Docker
- Containersを使えるCloudflareアカウント（**Containerの実行には課金が発生します**）

## 1. Workerをデプロイする

```bash
git clone https://github.com/kiyo-e/hermes-cloudflare-sandbox.git
cd hermes-cloudflare-sandbox/worker
npm ci
npm test
npm run typecheck
npx wrangler login
npm run deploy
```

secretを設定するまで、Workerはすべてのリクエストを拒否します。
secretを生成して登録します。

```bash
python -c 'import secrets; print(secrets.token_urlsafe(48))'
npx wrangler secret put SANDBOX_API_TOKEN
```

同じ値を、Hermesの`HERMES_CF_TOKEN`に設定します。
リポジトリ、`wrangler.jsonc`、Containerイメージには書き込まないでください。

`worker/wrangler.jsonc`で、イメージ（`hermes`）、既定のインスタンスの種類（`standard-1`）、許可する種類（`ALLOWED_INSTANCE_TYPES`）を設定します。
`ENABLE_INTERNET=true`は、gitやパッケージの取得のために外部通信を許可します。
禁止する場合は`false`にしてください。

## 2. Hermesへプラグインをインストールする

```bash
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins"
git clone https://github.com/kiyo-e/hermes-cloudflare-sandbox.git \
  "${HERMES_HOME:-$HOME/.hermes}/plugins/cloudflare-sandbox"
```

プロファイルの`.env`に、次の値を追記します（任意の設定は`.env.example`にあります）。

```dotenv
HERMES_CF_ENDPOINT=https://your-worker.your-subdomain.workers.dev
HERMES_CF_TOKEN=ここには生成したsecretを設定します
HERMES_CF_NAMESPACE=personal
HERMES_CF_IMAGE=hermes
```

```bash
hermes plugins enable cloudflare-sandbox
hermes config set terminal.backend cloudflare_sandbox
hermes config set terminal.cwd /workspace
hermes config set terminal.container_persistent true
```

設定したあとはHermesを再起動してください。
普段のプロファイルを手元のterminalのまま残すには、別のプロファイル（`hermes profile create <名前> --clone`）で試してください。

## 3. 動作を確認する

リポジトリの直下で実行します。

```bash
python scripts/check_hermes_contract.py --hermes-source /path/to/hermes-agent
python scripts/smoke.py --live
```

1つ目は、使っているHermesに、このプラグインが必要とするインターフェースがあるかを確認します。
2つ目は、環境変数に`HERMES_CF_ENDPOINT`と`HERMES_CF_TOKEN`が必要です。
一時的なワークスペースでコマンドの実行、snapshotの保存と復元を試し、最後にワークスペースを削除します。
通常の利用と同じように課金されます。

## ワークスペースと永続化

`container_persistent: true`では、namespaceとHermesのtask IDでワークスペースが決まり、ファイルはセッションをまたいで残ります。
別のtask IDや別の端末から同じワークスペースを使うには、`HERMES_CF_NAMESPACE`と`HERMES_CF_WORKSPACE`（例：`my-project`）に同じ値を設定してください。
一つのワークスペースを、複数のHermesプロセスから同時に使わないでください。

`container_persistent: false`では、セッションの終了時にワークスペースを削除します。

セッションが終わったとき、またはコマンドが約10分なかったときに（`wrangler.jsonc`の`IDLE_SECONDS`で変更できます）、ワークスペースをsnapshotへ保存してContainerを止めます。
保存に失敗した場合は、Containerを動かしたまま保存を再試行します。

**snapshotはバックアップの代わりになりません。**
保存するのはファイルだけなので、実行中のプロセス（バックグラウンドのプロセスを含む）は残りません。
Cloudflareは、snapshotを作成または復元から30日で削除します。
大事な成果物はgitに保存してください。

snapshotが一つもないままContainerが失われた場合、Workerは空のワークスペースを作らずに`workspace_lost`を返します。
新しいワークスペース名を使ってください。

## 設定

| 設定 | 意味 |
| --- | --- |
| `terminal.container_persistent` | セッションをまたいでワークスペースをsnapshotに残します。 |
| `terminal.cwd` | Container内の作業ディレクトリです。既定は`/workspace`です。 |
| `HERMES_CF_IMAGE` | `wrangler.jsonc`で定義したイメージの名前です。 |
| `HERMES_CF_INSTANCE` | `lite`、`standard-1`〜`standard-4`のうち、`ALLOWED_INSTANCE_TYPES`で許可した種類です。 |
| `HERMES_CF_ACCESS_CLIENT_ID`、`HERMES_CF_ACCESS_CLIENT_SECRET` | WorkerをCloudflare Accessで保護している場合のservice tokenです。 |

Hermesの汎用のContainerイメージ、CPU、メモリ、diskの設定は使いません。

## セキュリティ

bearer tokenを持つ人は、すべてのワークスペースで任意のコマンドを実行できます。
一人の所有者のためのbridgeで、ユーザーごとの権限、同時実行数の制限、料金の上限はありません。
ほかの人がWorkerに届く場合は、Cloudflare Accessで保護してください。

tokenはContainerへは渡しません。
ただし、Container内で書いたファイルはsnapshotにも入ります。

危険なコマンドに対するHermesの承認は有効のままです。
`hermes chat -q`のように承認する人がいない実行では、Hermesの承認の設定か`--yolo`で許可しない限り、`execute_code`はブロックされます。

## 制限と動作

| 項目 | 上限 |
| --- | --- |
| コマンド文字列 | 64 KiB |
| リクエスト本文 | 1 MiB |
| 1コマンドの出力 | 2,000,000文字 |
| 1コマンドの実行時間 | 900秒 |

出力が上限を超えた場合はエラーになり、途中で切った結果は返しません。
stdoutとstderrはまとめて返します。
標準入力はUTF-8のテキストにしてください。

タイムアウトしたコマンドには、SIGTERMを送り、2秒後にSIGKILLを送ります。
バックグラウンドのプロセス（`cmd &`）は、コマンドが返ったあとも動き続けます。
その出力を待つのは最長5秒なので、すべて必要な場合はファイルへリダイレクトしてください。

通信が切れた場合、コマンドはすでに実行されている可能性があります。
自動では再実行しません。

WorkerのAPIは[docs/protocol.md](docs/protocol.md)（英語）に記載しています。

## 開発

```bash
python -m pip install -e '.[test]'
python -m pytest -q
cd worker
npm ci
npm test
npm run typecheck
```

## 参考資料

- [Hermes terminal environment provider plugins](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/terminal-environment-plugin.md)
- [Cloudflare Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)
- [Cloudflare scheduling policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)
- [Cloudflare snapshots](https://developers.cloudflare.com/containers/guides/snapshots/)

## ライセンス

[MIT](LICENSE)です。
Container内のsupervisorの一部は、[openclaw/crabbox](https://github.com/openclaw/crabbox)（MIT）をもとにしています。
詳しくは[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)を参照してください。
