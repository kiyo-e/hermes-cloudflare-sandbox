# 検証記録

作成日：2026-09-30

## 実行済み

| 検証 | 結果 | 範囲 |
| --- | --- | --- |
| `python -m pytest -q` | **49件が成功しました。** | 設定、認証付きHTTPクライアント、リダイレクト拒否、NDJSON、実際のOS pipe、supervisorを検証しました。 |
| `cd worker && npm test` | **31件が成功しました。** | Worker coreのTypeScriptコンパイルと、テスト用Container・storageを利用する認証、実行、snapshot、復元、キャンセル、ハードタイムアウトを検証しました。 |
| `python -m compileall -q hermes_cloudflare_sandbox scripts worker/container/hermes-exec.py` | 成功しました。 | Pythonの構文を確認しました。HermesのimportやCloudflare接続の確認ではありません。 |

Pythonのsupervisorテストでは、実際のローカルBashを起動しています。日本語、標準入力、終了コード、タイムアウト、SIGTERMを無視する子プロセスの停止を確認しました。CloudflareのVM内で実行した結果ではありません。

Node.jsのハードタイムアウトテストには実験的なMockTimers APIを使用しています。警告は出ましたが、テストは成功しました。

検証環境はPython 3.13.5、Node.js 22.16.0、Linuxです。Python 3.11での実行は未確認です。CIには3.11と3.13を設定していますが、CIそのものはまだ実行していません。

## 未確認・実行できなかった検証

**次の項目を確認するまでは、実環境で動作検証済みのリリースとして扱わないでください。**

- 実際のHermesを読み込むインターフェース検証は、Hermesが作成環境にインストールされていないため、importエラーで終了しました。`scripts/check_hermes_contract.py`を導入先で実行してください。
- `npm run typecheck`は、Wranglerがインストールされていないため、`wrangler: not found`で終了しました。実際のCloudflareの型を生成したproduction entry pointの型チェックは未完了です。単体テスト用の型定義を実際のSDKの型と偽って使用することはしていません。
- ネットワークの名前解決ができず、npm依存関係やHermesの実行環境を取得できませんでした。`package-lock.json`は生成していません。
- Dockerが利用できなかったため、Containerイメージのビルドと起動は未実施です。
- Cloudflareアカウントへのデプロイ、実VMでの実行、snapshotの作成と復元は未実施です。`scripts/smoke.py --live`を用意していますが、作成環境では実行していません。
- 実際のHermesのterminal、file tools、`execute_code`、shell state、再起動後の利用については未確認です。

## 導入先で行う確認

`README.md`に従って依存関係を取得し、`npm run typecheck`とDockerのビルドを実行してください。型やWranglerの設定スキーマに差異が見つかった場合は、公開直後のネイティブAPIに合わせて修正が必要です。

その後に実際のHermesのインターフェース確認、Cloudflare bridgeのlive smoke test、Hermes経由のterminal・file・code操作を確認してください。live smoke testは一時的なContainerとsnapshotを作成するため、課金が発生する可能性があります。
