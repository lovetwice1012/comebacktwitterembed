# MAIN-DATA-1 / MAIN-DATA-2 独立再検証

対象は統合後 `main` の HEAD `2a000c89a293e2ee71ef0c579a63def2ff12cbdb`。両候補とも **valid / P2 / not fixed** と独立判定した。製品ソース、本番、Square、外部サービスは変更・操作していない。

## MAIN-DATA-1 — Push枠履歴がSquare scopeをまたいで混在する

同じ利用者に、現在scopeの `sandbox / MERCHANT_CURRENT / 500円` と、別scopeの `production / MERCHANT_FOREIGN / 999円` を保存した。

実API `GET push-capacity/history` は、別scopeの999円を含む2件を返した。新しい別scope行が先頭になったが、各DTOには `environment` も `merchantId` もなかった。同じDB・利用者に対する `donor-admin.history()` 正常対照は、現在scopeの500円だけを返した。

原因は `src/automation/api.js:80-82`。支援grant履歴と利用者IDは固定する一方、payment queryは `owner_user_id` だけを条件にし、Square environment・merchantを使わない。cursorもscopeを持たず、返却行からscopeを判断できない。

この履歴は管理者が過去購入枠を手動記録する根拠として表示する。sandbox、旧加盟店、別運用scopeの支払いを現在の購入として判断し得るためP2。自動grantはこのGETだけでは変更されず、管理者限定なのでP1ではない。

修正時は現在のSquare scopeでqueryとcursorを固定する。複数scopeを意図して表示する設計なら、各行へenvironment・merchantを明示し、手動付与対象scopeを別途確認する必要がある。

## MAIN-DATA-2 — 通報解決と監査INSERTが原子的でない

実Marketplace/API経路で未処理reportを作り、`service.audit`だけを失敗させた。

1. `POST reports/:id` は `INDEPENDENT_AUDIT_FAILURE` を返した。
2. `automation_feedback.state` はすでに `resolved` だった。
3. 同じreport IDの `report.resolve` 監査行は0件だった。
4. 同じAPI操作の再試行は `NOT_FOUND / 404` になった。
5. reportを通常経路で再度openにし、正常serviceで解決する対照は `{ resolved: true }`、state `resolved`、監査1件になった。

原因は `src/automation/marketplace-core.js:390-392`。条件付きUPDATEを `db.queryDatabase` でcommitした後、別の `service.audit(db.queryDatabase, ...)` を実行する。監査失敗を同じtransactionでrollbackできない。

APIは失敗表示なのに実状態は解決済みで、画面が保持した未処理行を再試行しても成功できない。モデレーション状態と監査証跡が分裂するためP2。UPDATEと監査INSERTを同じ `withDatabaseTransaction` に入れ、open行の条件付き更新と既存404境界を維持する必要がある。

## 検証

独立probeはランダムな使い捨てMariaDB schemaを使用し、終了時に削除した。関連するdonor admin、Push capacity、Marketplace、publicationの4試験ファイルは **53件成功、失敗0、skip 0**。

- [独立probe](independent-data-findings-probe.cjs)
- [機械可読結果](independent-data-findings.json)

実決済、顧客、plan、Discord/X通知、本番DBは作成していない。
