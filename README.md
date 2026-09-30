# Hermes Cloudflare Sandbox

Hermes Agentのterminal backendを、CloudflareのDurable Objectが管理するContainerへ接続する外部プラグインです。Hermes本体はローカル環境または通常のサーバー上に残します。

**ステータス：初期実装です。ローカルの単体テストは実行済みですが、実際のHermesとCloudflareアカウントを組み合わせた動作確認は未実施です。公式対応を意味するものではありません。** 検証の範囲は[VALIDATION.md](VALIDATION.md)を参照してください。

2026年9月30日に公開された`durable_object` scheduling policyと、ネイティブの`ctx.container` APIを対象にしています。従来の`Container`クラスや旧`Sandbox`クラスには依存しません。これらのCloudflare機能はpublic betaであるため、導入先での互換性確認が必要です。

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

Hermesの公式provider登録、認証付きの実行API、標準入力、UTF-8のストリーミング出力、終了コード、実行時間の制限、キャンセル、名前付きイメージ、実行時のインスタンス選択、ワークスペースのsnapshot保存と復元を実装しています。アイドル時にはDurable Objectのalarmで保存してから停止します。

コマンドのラッピング、CWDの追跡、Hermesが対応するshell snapshotの処理は、Hermesの`BaseEnvironment`へ委譲します。tmuxを別途重ねる構成ではありません。これは「同じBashのPIDや任意のメモリ状態を永久に維持する」という保証ではなく、shell stateの範囲は導入先のHermesの実装に従います。

`terminal`を利用するファイル操作やコード実行を接続する設計ですが、Hermes全体、ブラウザー、すべての外部ツールをCloudflare内へ移すものではありません。ホスト側のホーム、skills、認証情報を自動で同期する機能も含めていません。

## 必要な環境

Hermesには`TerminalEnvironmentProvider`と`BaseEnvironment._run_bash()`を備えたバージョンが必要です。Python 3.11以上、Node.js 22以上、Docker、および新しいContainers APIを利用できるCloudflareアカウントを用意してください。課金が発生する可能性があります。

Workerの依存関係はWrangler 4系とTypeScriptです。新APIが利用できる最新のWranglerをインストールし、実際の型生成と型チェックを通してからデプロイしてください。作成環境ではnpmの取得ができなかったため、未検証のlockfileは同梱していません。初回の検証後に生成された`worker/package-lock.json`をコミットして固定してください。

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

`npm run typecheck`は`wrangler types`を実行し、実際のCloudflareの型に対してproduction entry pointをチェックします。新しいscheduling policyや`ctx.container.exec()`の型が見つからない場合は、旧SDKへ置き換えず、Wranglerと利用するCloudflare機能を確認してください。

最初のデプロイでは認証secretが未設定なので、WorkerはAPIアクセスを拒否します。その状態で新しいランダムなsecretを生成します。

```bash
python -c 'import secrets; print(secrets.token_urlsafe(48))'
npx wrangler secret put SANDBOX_API_TOKEN
```

生成した値をプロンプトへ入力します。同じ値を後でHermesの`HERMES_CF_TOKEN`へ設定します。secretはリポジトリ、`wrangler.jsonc`、Containerイメージへ書き込まないでください。CloudflareアカウントのAPI tokenを、この実行用tokenとして流用しないでください。

`worker/wrangler.jsonc`では、SQLiteのDurable Object、新しいscheduling policy、名前付きイメージ`hermes`を設定しています。`standard-1`が既定のインスタンスで、`lite`と`standard-1`のみを許可します。ほかのサイズを使用する場合は、管理者が`ALLOWED_INSTANCE_TYPES`を変更してください。旧policy用の`max_instances`や`instance_type`を追加しないでください。

`ENABLE_INTERNET=true`は、gitやパッケージの取得を許可するための明示的な設定です。外部通信を禁止する場合は`false`へ変更して再デプロイしてください。

## 2. Hermesへプラグインをインストールする

使用するHermesプロファイルのpluginsディレクトリへ、このリポジトリを配置します。

```bash
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins"
git clone https://github.com/kiyo-e/hermes-cloudflare-sandbox.git \
  "${HERMES_HOME:-$HOME/.hermes}/plugins/cloudflare-sandbox"
```

Hermesを起動するプロセスの環境変数、または対象プロファイルの`.env`へ、次の値を設定します。既存の`.env`を上書きしないでください。`.env.example`に任意設定も記載しています。

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

**プラグイン名は`cloudflare-sandbox`、backend名は`cloudflare_sandbox`です。** 設定を変更した後はHermesを再起動してください。

Python側の通信処理に追加の外部パッケージは不要です。`pip install`だけではHermesへのプラグイン登録にはなりません。上記のディレクトリ配置と`hermes plugins enable`を使用してください。

## 3. 実環境で確認する

Hermesを実行しているPython環境で、まず実際のインターフェースを確認します。

```bash
python scripts/check_hermes_contract.py --hermes-source /path/to/hermes-agent
```

続いて、Workerの接続情報を環境変数へ設定したシェルで、独立したワークスペースを作って検証します。

```bash
python scripts/smoke.py --live
```

このスクリプトは、認証、標準入力、日本語、非ゼロの終了コード、タイムアウト、ファイルの保存、停止、snapshotからの復元を確認します。一時的なContainerとsnapshotを作成するため課金される可能性があります。既存の`HERMES_CF_WORKSPACE`は使用しません。最後にテスト専用のワークスペースを削除しますが、Cloudflare側のsnapshot自体はTTLまで残ることがあります。

最後にHermesから`pwd`、ファイルの書き込みと読み出し、`execute_code`を確認してください。shell stateの引き継ぎについても、利用するHermesのバージョンで確認してください。このライブ確認は作成環境では実行していません。

## ワークスペースの識別と永続化

`container_persistent: true`では、namespaceとtask IDをハッシュ化して同じDurable Objectへ接続します。別のtask IDから同じプロジェクトを開く場合は、例えば`HERMES_CF_WORKSPACE=my-project`を明示してください。固定しない場合は、新しいtask IDに対して別のワークスペースが作られます。

namespaceを省略した場合は、プラグイン内では対象のHermes homeを使用します。別の端末から同じワークスペースへ接続する場合は、同じnamespace、workspace、Workerの接続先を明示してください。同じ固定workspaceを複数のHermesプロセスから同時に使わないでください。Workerは同時の前景コマンドを拒否しますが、複数のクライアントのshell stateを共有・調停する機能ではありません。

`container_persistent: false`では毎回ランダムな識別子を付け、終了時にContainerとDurable Object内の管理情報を削除します。snapshotは作成しません。

永続化する場合の終了処理は、`sync`、snapshot作成、handleのDurable Object storageへの保存、Containerの停止という順序です。snapshotやhandleの保存に失敗したときは、そのエラーを返し、停止せずに再試行用のalarmを設定します。既定では、最後のコマンドから約10分間のアイドル状態でも同じ保存処理を行います。さらに長いネイティブのinactivity timeoutは、保存処理が失敗した場合も含む最終的な停止用の仕組みであり、保存を保証する機能ではありません。

**snapshotはバックアップの代わりではありません。** ファイルシステムのみを保存し、実行中のPID、メモリ、外部サービス、マウントした別ストレージの状態は保存しません。Cloudflareの仕様上、作成または復元から30日間という有効期限があり、基になったイメージにも結び付いています。イメージを更新しただけでは既存snapshotの環境は更新されません。長期保存が必要な成果物は、別途gitなどへ保存してください。

クラッシュや強制停止では、最後の成功したsnapshot以降の変更が失われる可能性があります。初回起動後にsnapshotなしでContainerが失われた場合は、空の環境を黙って作り直さず、`workspace_lost`を返します。復元できない場合は原因を確認して、新しいworkspace名を使用してください。

## 設定の範囲と制限

| 設定・機能 | この実装の扱い |
| --- | --- |
| `terminal.container_persistent` | snapshot保存の有効・無効を切り替えます。 |
| `terminal.cwd` | Container内の絶対パスとして使用します。既定は`/workspace`です。 |
| `HERMES_CF_IMAGE` | `wrangler.jsonc`でデプロイ済みの名前付きイメージを指定します。 |
| `HERMES_CF_INSTANCE` | 管理者が許可したCloudflareのインスタンス名を指定します。 |
| Hermesの汎用image・CPU・メモリ・disk設定 | 自動変換しません。上記の専用設定を使用してください。 |
| Hermesのホスト側の環境変数・ホーム | 自動ではContainerへ転送・同期しません。 |
| Cloudflare Access | client IDとclient secretをHTTPヘッダーに設定できます。Access policy自体の作成は含みません。 |

単一の信頼する所有者向けのbridgeです。bearer tokenの所持者は任意のshellコマンドを実行し、全workspaceを操作できます。workspace名は認可の境界ではありません。複数の信頼しない利用者へ提供するためのユーザー別認可、全体の同時実行数制限、料金上限の実装は含みません。公開する場合はAccessなどのアクセス制御と運用上の利用制限を追加してください。

HTTPSを必須にし、リダイレクトを拒否します。HTTPはローカルテストのloopbackだけに限定しています。認証secretはWorkerとHermes側に置き、Containerへは渡しません。秘密情報をContainerのファイルへ書き込むとsnapshotにも含まれるため、必要最小限にしてください。危険なコマンドに対するHermes側の承認を意図的に無効化する設定にはしていません。

コマンド文字列は64 KiB、リクエストは1 MiB、実行結果はJavaScriptの文字列長で2,000,000単位、実行時間は最大900秒に制限しています。標準入力はUTF-8のテキストで、NUL文字は受け付けません。大きなファイルは分割または別の転送手段を使用してください。出力の上限に達した場合はエラーとし、切り捨てたデータを正常なファイル内容として返しません。stdoutとstderrは統合されます。

通信が切れた場合でもコマンドがすでに実行されている可能性があるため、自動再実行はしません。直近64件のrequest IDを保存し、同じIDの再送を拒否しますが、これは無期限のexactly-once保証ではありません。エラー後には副作用を確認してください。

タイムアウトとキャンセルは、Container内のsupervisorがBashのprocess groupへシグナルを送って処理します。停止に応答しない場合はWorker側がContainerを強制停止する経路もあります。このsupervisor自体を、悪意のあるプログラムに対する独立したセキュリティ境界としては扱わないでください。バックグラウンドのプロセスもContainerがアイドル停止した後には継続しません。

## 開発とテスト

```bash
python -m pip install -e '.[test]'
python -m pytest -q
cd worker
npm ci
npm test
npm run typecheck
```

Workerの単体テストはContainerとDurable Object storageのテスト用オブジェクトを使用します。`npm test`でcoreのTypeScriptコンパイルも行いますが、それだけではproduction entry pointと実際のCloudflareの型の整合性は検証しません。`npm run typecheck`とライブテストを別途実行してください。

GitHub ActionsにはPythonテスト、Workerテスト、Wranglerの型生成と型チェック、Dockerのビルドと起動確認を設定しています。自動デプロイやCloudflare認証情報の登録は行いません。Actions自体はまだ実行していません。

## 参照した公式インターフェース

- [Hermes Terminal Environment Provider Plugins](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/terminal-environment-plugin.md)
- [Hermes BaseEnvironment](https://github.com/NousResearch/hermes-agent/blob/main/tools/environments/base.py)
- [Cloudflare Faster Agent Sandboxes](https://blog.cloudflare.com/faster-agent-sandboxes/)
- [Cloudflare Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)
- [Cloudflare Scheduling Policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)
- [Cloudflare Snapshots](https://developers.cloudflare.com/containers/guides/snapshots/)

このプロジェクトはHermesまたはCloudflareによる公式のプラグインではありません。
