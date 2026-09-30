# Hermes Cloudflare Sandbox

[English](README.md) | **日本語** | [简体中文](README.zh-CN.md)

[Hermes Agent](https://github.com/NousResearch/hermes-agent)のterminal backendを、CloudflareのDurable Objectが管理するContainerで動かす外部プラグインです。
Hermes本体は手元の環境やサーバーに残し、コマンドの実行だけをCloudflareへ移します。

**ステータス：初期実装です。** 実際のCloudflareアカウントとHermesで、基本の操作を確認しました。
確認した範囲は[VALIDATION.md](VALIDATION.md)を参照してください。
HermesやCloudflareの公式プラグインではありません。

2026年9月30日に公開された`durable_object` scheduling policyと、ネイティブの`ctx.container` APIを対象にしています。
従来の`Container`クラスや旧`Sandbox`クラスには依存しません。
これらのCloudflare機能はpublic betaのため、導入先での互換性確認が必要です。

```text
Hermes Agent
  └─ TerminalEnvironmentProvider: cloudflare_sandbox
       └─ BaseEnvironment / streaming ProcessHandle
            └─ HTTPS + bearer token
                 └─ Cloudflare Worker
                      └─ HermesSandbox Durable Object
                           └─ ctx.container
                                ├─ 非rootのBash / Python / Node.js
                                ├─ /workspace
                                └─ filesystem snapshot / restore
```

## 実装している機能

- Hermesのterminal environment providerの仕組みを通じて組み込まれます。
- 認証付きの実行APIです。標準入力、UTF-8のストリーミング出力、終了コード、実行時間の制限、キャンセルに対応します。
- 名前付きイメージと、ワークスペースごとのインスタンス選択に対応します。
- ワークスペースのsnapshot保存と復元に対応します。アイドル状態のワークスペースは、Durable Objectのalarmで保存してから停止します。
- 手元の計測では、ワークスペースの起動や復元で、最初のコマンドが1〜2秒ほど遅れました。

コマンドのラッピング、CWDの追跡、shell snapshotの処理は、Hermesの`BaseEnvironment`へ委譲します。
tmuxを別途重ねる構成ではありません。
同じBashのPIDやメモリ上の状態を永久に保つわけではなく、shell stateをどこまで引き継ぐかは導入先のHermesの実装に従います。

対象は`terminal`、ファイル操作、`execute_code`です。
Hermesのほかの部分（ブラウザーや外部ツール）をCloudflareへ移すものではありません。
ホスト側のホームディレクトリ、skills、認証情報をContainerへ同期する機能もありません。

## 必要な環境

- `TerminalEnvironmentProvider`と`BaseEnvironment._run_bash()`を備えたHermes
- Python 3.11以上、Node.js 22以上
- Docker（WranglerがContainerイメージのビルドに使います）
- 新しいContainers APIを利用できるCloudflareアカウント（**Containerの実行には課金が発生します**）

Workerの依存関係（Wrangler 4系とTypeScript）は、`worker/package-lock.json`で版を固定しています。
`npm ci`で導入し、実際の型生成と型チェックを通してからデプロイしてください。

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

`npm run typecheck`は`wrangler types`を実行し、実際のCloudflareの型に対してproduction entry pointを確認します。
新しいscheduling policyや`ctx.container.exec()`の型が見つからない場合は、旧SDKへ置き換えず、WranglerとCloudflareの機能の状態を確認してください。

最初のデプロイの直後は認証secretが未設定なので、WorkerはすべてのAPIアクセスを拒否します。
新しいランダムなsecretを生成し、Workerのsecretとして登録します。

```bash
python -c 'import secrets; print(secrets.token_urlsafe(48))'
npx wrangler secret put SANDBOX_API_TOKEN
```

生成した値をプロンプトへ入力します。
同じ値を、あとでHermesの`HERMES_CF_TOKEN`へ設定します。
secretをリポジトリ、`wrangler.jsonc`、Containerイメージへ書き込まないでください。
CloudflareアカウントのAPI tokenを、この用途に流用しないでください。

`worker/wrangler.jsonc`では、SQLiteのDurable Object、新しいscheduling policy、名前付きイメージ`hermes`を設定しています。
既定のインスタンスは`standard-1`で、`lite`と`standard-1`だけを許可します。
ほかのサイズを使う場合は、管理者が`ALLOWED_INSTANCE_TYPES`を変更してください。
旧policy用の`max_instances`や`instance_type`は追加しないでください。

`ENABLE_INTERNET=true`は、gitやパッケージの取得のために外部通信を明示的に許可する設定です。
外部通信を禁止する場合は`false`に変えて再デプロイしてください。

## 2. Hermesへプラグインをインストールする

使用するHermesプロファイルの`plugins`ディレクトリへ、このリポジトリを配置します。

```bash
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins"
git clone https://github.com/kiyo-e/hermes-cloudflare-sandbox.git \
  "${HERMES_HOME:-$HOME/.hermes}/plugins/cloudflare-sandbox"
```

Hermesを起動するプロセスの環境変数、または対象プロファイルの`.env`へ、次の値を追記します。
既存の`.env`を上書きしないでください。
任意の設定は`.env.example`に記載しています。

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

**プラグイン名は`cloudflare-sandbox`、backend名は`cloudflare_sandbox`です。**
設定を変更したあとはHermesを再起動してください。

Python側の通信処理に、追加の外部パッケージは不要です。
`pip install`だけではHermesへのプラグイン登録になりません。
上記のディレクトリ配置と`hermes plugins enable`を使ってください。
最初は専用のプロファイル（`hermes profile create <名前> --clone`）で試すと、普段のプロファイルは手元のterminalのまま使えます。

## 3. 実環境で確認する

まず、Hermesを実行しているPython環境で、実際のインターフェースを確認します。

```bash
python scripts/check_hermes_contract.py --hermes-source /path/to/hermes-agent
```

続いて、Workerの接続先とtokenを環境変数に設定したシェルで、新しいワークスペースを使って確認します。

```bash
python scripts/smoke.py --live
```

このスクリプトは、認証、標準入力、日本語、0以外の終了コード、タイムアウト、ファイルの保存、停止、snapshotからの復元を確認します。
一時的なContainerとsnapshotを作るため、課金される可能性があります。
既存の`HERMES_CF_WORKSPACE`は使いません。
最後にテスト用のワークスペースを削除しますが、Cloudflare側のsnapshotのデータはTTLまで残ることがあります。

最後にHermesから、`pwd`、ファイルの書き込みと読み出し、`execute_code`を確認してください。
shell stateの引き継ぎも、利用するHermesのバージョンで確認してください。

## ワークスペースの識別と永続化

`container_persistent: true`では、namespaceとtask IDをハッシュ化し、毎回同じDurable Objectへ接続します。
別のtask IDから同じプロジェクトを開く場合は、`HERMES_CF_WORKSPACE=my-project`のように固定のworkspaceを設定してください。
設定しない場合は、新しいtask IDごとに別のワークスペースが作られます。

namespaceを省略した場合は、そのプロファイルのHermes homeのパスをnamespaceとして使います。
そのため、そのディレクトリを移動すると別のワークスペースになります。
別の端末から同じワークスペースへ接続する場合は、namespace、workspace、Workerの接続先を同じ値で明示してください。
同じ固定workspaceを、複数のHermesプロセスから同時に使わないでください。
Workerは同時の前景コマンドを拒否しますが、複数のクライアントのshell stateを共有したり調停したりはしません。

`container_persistent: false`では、毎回ランダムな識別子を付けます。
終了時にContainerとDurable Object内の管理情報を削除し、snapshotは作りません。

永続化する場合の終了処理は、`sync`、snapshotの作成、handleのDurable Object storageへの保存、Containerの停止の順です。
snapshotやhandleを保存できなかったときは、エラーを返し、Containerを止めずにalarmで保存を再試行します。
既定では、最後のコマンドから約10分たったときにも同じ保存処理を行います。
Cloudflare側のinactivity timeoutは、それより5分長く設定しています。
保存に失敗し続けた場合も含めた最終的な停止の仕組みで、それ自体は何も保存しません。

**snapshotはバックアップの代わりにはなりません。**
保存するのはファイルシステムだけで、実行中のプロセス、メモリ、外部サービス、別にマウントしたストレージの状態は含みません。
そのため、バックグラウンドのプロセスは保存と停止をまたいで続きません。
Cloudflareの仕様で、snapshotは作成または復元から30日で期限が切れ、元になったイメージにも結び付いています。
イメージを更新しても、既存のsnapshotから復元した環境は更新されません。
長く残したい成果物は、gitなど別の場所へ保存してください。

クラッシュや強制停止では、最後に成功したsnapshot以降の変更が失われる可能性があります。
初回の起動後、snapshotがないままContainerが失われた場合は、空の環境を黙って作り直さず、`workspace_lost`を返します。
原因を確認し、新しいworkspace名を使ってください。

## 設定の範囲

| 設定と機能 | この実装での扱い |
| --- | --- |
| `terminal.container_persistent` | snapshotによる永続化の有効と無効を切り替えます。 |
| `terminal.cwd` | Container内の絶対パスとして使います。既定は`/workspace`です。 |
| `HERMES_CF_IMAGE` | `wrangler.jsonc`でデプロイした名前付きイメージを指定します。 |
| `HERMES_CF_INSTANCE` | 管理者が許可したCloudflareのインスタンス名を指定します。 |
| Hermesの汎用のimage、CPU、メモリ、diskの設定 | 自動では変換しません。上記の専用の設定を使ってください。 |
| ホスト側の環境変数とホームディレクトリ | Containerへ転送や同期はしません。 |
| Cloudflare Access | client IDとclient secretをHTTPヘッダーで送れます。Access policyの作成は含みません。 |

## セキュリティの前提

信頼できる一人の所有者のためのbridgeです。
bearer tokenを持つ人は、任意のshellコマンドを実行でき、すべてのworkspaceを操作できます。
workspace名は認可の境界ではありません。
ユーザーごとの認可、全体の同時実行数の制限、料金の上限は含みません。
Workerをほかの人に公開する場合は、Cloudflare Accessなどのアクセス制御を前段に置き、利用制限も別に用意してください。

HTTPSを必須にし、リダイレクトを拒否します。
HTTPはローカルテスト用のloopbackだけで受け付けます。
tokenはWorkerとHermes側にだけ置き、Containerへは渡しません。
Container内のファイルへ書いたものはsnapshotにも含まれるため、秘密情報は最小限にしてください。

このbackendでも、危険なコマンドに対するHermesの承認は有効のままです。
`hermes chat -q`のように承認する人がいない実行では、Hermesの承認の設定か`--yolo`で許可しない限り、`execute_code`はブロックされます。

## 制限

| 項目 | 上限 |
| --- | --- |
| コマンド文字列 | 64 KiB |
| リクエスト本文 | 1 MiB |
| 1コマンドの出力 | 2,000,000文字（JavaScriptの文字列長） |
| 1コマンドの実行時間 | 900秒 |

標準入力はUTF-8のテキストで、NUL文字は受け付けません。
大きなファイルは分割するか、別の手段で転送してください。
出力が上限を超えた場合はエラーにし、切り捨てた結果を黙って返すことはしません。
stdoutとstderrは一つにまとめて返します。

通信が切れた場合、コマンドがすでに実行されている可能性があるため、自動では再実行しません。
Workerは直近64件のrequest IDを記録し、同じIDの再送を拒否しますが、無期限のexactly-once保証ではありません。
エラーのあとは副作用を確認してください。

## タイムアウト、キャンセル、バックグラウンドのプロセス

タイムアウトとキャンセルは、Container内のsupervisorがBashのprocess groupへシグナルを送って処理します。
まずSIGTERMを送り、2秒後にSIGKILLを送ります。
タイムアウトから15秒たっても終わらない場合は、Workerがrequest IDを指定してそのコマンドのprocess groupを止め、ワークスペースは残します。
Containerを破棄するのは、その停止自体が実行できなかった場合だけです。

バックグラウンドのプロセス（`cmd &`）は、コマンドが返ったあとも動き続け、応答を引き止めません。
その出力は、コマンドの終了後も0.3秒途切れるまで、最長5秒のあいだ届けます。
すべての出力が必要な場合は、ファイルへリダイレクトしてください。
この出力の扱いは、[openclaw/crabbox](https://github.com/openclaw/crabbox)（MIT）の設計に従っています。

supervisorは資源管理のための仕組みです。
process groupから意図的に抜け出すコードに対するセキュリティ境界ではありません。

## 開発とテスト

```bash
python -m pip install -e '.[test]'
python -m pytest -q
cd worker
npm ci
npm test
npm run typecheck
```

Workerの単体テストは、ContainerとDurable Object storageのテスト用オブジェクトを使います。
`npm test`はcoreのTypeScriptもコンパイルしますが、production entry pointと実際のCloudflareの型の整合性までは確認しません。
その確認には`npm run typecheck`とライブテストを使ってください。

GitHub Actionsでは、Pythonのテスト、Workerのテスト、Wranglerの型生成と型チェック、Dockerのビルドと起動の確認を実行します。
デプロイは行わず、Cloudflareの認証情報も持ちません。

## 参照した公式インターフェース

- [Hermes Terminal Environment Provider Plugins](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/terminal-environment-plugin.md)
- [Hermes BaseEnvironment](https://github.com/NousResearch/hermes-agent/blob/main/tools/environments/base.py)
- [Cloudflare Faster Agent Sandboxes](https://blog.cloudflare.com/faster-agent-sandboxes/)
- [Cloudflare Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)
- [Cloudflare Scheduling Policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)
- [Cloudflare Snapshots](https://developers.cloudflare.com/containers/guides/snapshots/)
