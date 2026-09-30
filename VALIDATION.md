# 検証記録

最終更新：2026-10-01

## 実行済み

| 検証 | 結果 | 範囲 |
| --- | --- | --- |
| `python -m pytest -q` | **58件が成功しました。** Python 3.11と3.13の両方です。 | 設定、認証付きHTTPクライアント、User-Agent、リダイレクト拒否、NDJSON、実際のOS pipe、supervisorを検証しました。supervisorには、openclaw/crabboxから移植した出力待ちのテストを含みます。 |
| `cd worker && npm ci && npm test` | **36件が成功しました。** Node.js 22と26で確認しました。 | 認証、実行、snapshot、復元、キャンセル、ハードタイムアウト、出力ストリームが閉じない場合の上限を検証しました。 |
| `npm run typecheck` | 成功しました。 | `wrangler types`で生成した実際のCloudflareの型に対して、production entry pointを確認しました。 |
| Containerイメージのビルドと起動 | 成功しました。 | バックグラウンド処理つきのコマンドが約0.4秒で返ること、SIGTERMを無視するコマンドが止まること、request IDを指定した停止を、イメージ内で確認しました。 |
| `scripts/check_hermes_contract.py` | PASSしました。 | Hermes `6a8ef0c061`（2026-09-29）で、関数の形が合っていることを確認しました。 |
| `wrangler deploy`と`scripts/smoke.py --live` | PASSしました。 | 実際のCloudflareで、認証、標準入力の日本語、0以外の終了コード、タイムアウト、snapshot、復元を確認しました。 |
| Hermes経由の操作 | 成功しました。 | `terminal`、`write_file`、`read_file`、`execute_code`を確認しました。cwdは次の呼び出しに引き継がれます。`timeout=5`のコマンドは終了コード124で止まり、次のコマンドはそのまま動きました。バックグラウンド処理は、起動した会話の中では最後まで動きました。 |

## 実際に動かして見つかった問題と修正

- Cloudflareのボット対策が、urllibの既定のUser-Agent（`Python-urllib/x.y`）を403（error 1010）で弾いていました。クライアントが名前付きのUser-Agentを送るように直しました。
- Durable Objectのコンストラクターで`setInactivityTimeout`を呼んでいました。ネイティブのAPIは起動前に呼ぶと例外を出すため、すべての要求が503になっていました。呼び出しを外しました。起動直後の`ensureRunning()`ですでに設定しています。テスト用の偽物にも同じ制約を入れました。
- 新しいworkerdの型では、`TextDecoder`のオプションに`ignoreBOM`が必須になっていました。

## 仕様上の注意

- Hermesのセッションが終わると、永続ワークスペースは保存されて止まります。snapshotに入るのはファイルだけで、実行中のプロセスは入りません。セッションの終わりをまたいだバックグラウンド処理は続きません。
- このbackendでは、承認の確認を省く設定（`skip_container_guards`）を意図的に`False`にしています。そのため、承認できる人がいない`hermes chat -q`では、`execute_code`がブロックされます。対話セッションを使うか、`--yolo`を付けるか、承認の設定を変えてください。

## 未確認

- アイドル時のalarmで保存して止まる動作と、長時間使った後の課金は、実際のCloudflareでは確認していません。
- メッセージングのgatewayから、このbackendを使う場合は確認していません。
- CloudflareのContainersとscheduling policyはpublic betaです。仕様が変わる可能性があります。
