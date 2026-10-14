# X自動展開の枠制度 受入試験表

更新日: 2026-10-14 JST。追加指示の枠制度を既存指示書より優先する。
Phase 0は199件成功で再確認済み。下記の枠制度は最終コードでローカル受入を確認した。
実受信・本番提供のG1受入とは分けて判定する。

**最新の追加指示により、枠移動は利用者または管理者による明示操作だけとする。**
無料枠の解放、プラン変更、上限変更、資格再確認による自動再配置を禁止する。
資格を失った登録は停止状態として現在の枠・個人枠を保持し、明示した移動または解除まで
その占有を数える。元の必須項目11・15は、この手動移動要件に合わせて検証する。

2026-10-14のローカル試験結果:

- `automation-x-quota-sql.test.js`: **34成功、0失敗、0スキップ、0TODO**。
  33件の独立スキーマ試験と親試験。実DBの枠管理、既存登録との共用、
  HTTPディスパッチャー、手動移動、DB障害・監査障害、独立Nodeプロセスでの永続化を確認。
- 枠34件を含む実DB統合試験: **198成功、失敗・スキップ・TODO 0、75.6秒**。
  [quota-allocation-tests.xml](quota-allocation-tests.xml) が最終証拠。
  台帳、既存プラン・支援・課金・間隔、移行、読み取り専用診断を含む。
  旧基本上限20＋追加2の維持、新1,000円支援の永久2枠だけを通常通知・Xで共有、
  破損容量の受付拒否、秘密設定の遮断、異常利用者の診断、DB障害の伝播も成功した。
- 管理者・利用者画面のDOM試験: **131成功、失敗・スキップ・TODO 0**。
  [quota-ui-tests.xml](quota-ui-tests.xml)。既存画面の設定・履歴・手動移動・拒否理由、
  登録件数と短縮枠込み使用数の区別を確認。
- 旧Discord枠設定コマンド: **3成功**。
  [quota-command-tests.xml](quota-command-tests.xml)。絶対値設定、職員権限、
  再送時の二重付与防止を確認。root/dashboardのtypecheck・lintも各成功した。

WindowsのNode起動異常が一度発生した原本は
[quota-allocation-tests-startup-failure.xml](quota-allocation-tests-startup-failure.xml)
に保存した。原因は未特定。該当単体9件、コード変更なしの統合再試験、および破損容量の
最終修正を含む198件は成功した。起動失敗を成功に読み替えていない。

再現コマンド（PowerShell、検証済み一時MariaDB `127.0.0.1:33621`）:

```powershell
$env:AUTOMATION_TEST_DB_PORT='33621'
node --test --test-concurrency=1 scripts/test/automation-x-quota-sql.test.js
node --test --test-concurrency=1 scripts/test/automation-push-support-grants-sql.test.js scripts/test/autoextract.additionalautoextractslot.test.js
```

統合198件・DOM131件の再現コマンドと移行／切り戻し手順は
[quota-operations.md](quota-operations.md) を参照。

試験DBは、明示した非本番ポート上のMariaDBに作成する
`cbte_automation_test_<20hex>` スキーマのみを使用する。DB試験は直列に起動する。
同時実行の検証には、この実DB上で独立したトランザクションを同時に実行する。
決済試験は既存Square連携の検証済み観測を模擬し、実課金・本番Webhookは有効化しない。

| 要件 | 検証内容 | 受入証拠 | 現在の状態 |
|---|---|---|---|
| 1 | 無料49件時の2件同時登録が成功1件・拒否1件、合計50件 | quota SQL / free49 race | ローカル合格 |
| 2 | 無料50件時の一般無料ユーザーの登録拒否と具体的な全体満枠理由 | quota SQL / pool full | ローカル合格 |
| 3 | Basicの有償特殊枠への移行、既存設定参照、個人上限消費 | quota SQL / paid spillover | ローカル合格 |
| 4 | 支援者の独立した優先枠への移行 | quota SQL / supporter spillover | ローカル合格 |
| 5 | Basicかつ支援者で無料→支援者→有償特殊の順序 | quota SQL / ordered allocation | ローカル合格 |
| 6 | 各枠種別の優先度・確認間隔・制限が同じ現在プランから取得される | quota SQL / plan quality | ローカル合格 |
| 7 | 支援者買い切り追加枠による個人上限加算、解約後も保持 | grants SQL + quota SQL / permanent allowance | ローカル合格 |
| 8 | 有償特殊枠が個人上限を増加させない | quota SQL / paid personal cap | ローカル合格 |
| 9 | 同じXアカウントを異なる10利用者が登録すると10枠 | quota SQL / shared account | ローカル合格 |
| 10 | 解除の正しいプール解放、繰り返し解除でも負数・二重解放なし | quota SQL / idempotent release | ローカル合格 |
| 11 | 変更・解約時は移動せず停止・占有を保持、明示操作で別枠へ移動 | quota SQL / downgrade + manual move | ローカル合格 |
| 12 | 旧付与数を購入回数として維持、過去金額から再計算しない | grants SQL / legacy migration | ローカル合格 |
| 13 | 新規支援500円につき1枠、端数切り捨て、500円未満0枠 | grants SQL / new payment amounts | ローカル合格 |
| 14 | 同一決済・Webhook再送で追加枠を二重付与しない | grants SQL / payment replay | ローカル合格 |
| 15 | 無料枠解放による自動移動なし、手動移動で設定・対象・購読状態・品質を保持 | quota SQL / manual move retention | ローカル合格 |
| 16 | 新しいNodeプロセスでもDB割当・設定・個人枠IDを保持 | quota SQL / persisted restart | ローカル合格 |
| 17 | 無料・有料の通常auto/price登録と共用個人上限、旧支援者の基本上限保持、新支援の二重加算禁止 | quota SQL / native regression + existing SQL suites | ローカル合格 |

追加受入項目: 支援者99件の2件同時登録、1利用者の最後の個人枠を通常登録とX登録が
同時消費、同一利用者同一対象の同時登録、個人上限到達と全体満枠の理由の区別、
他人の取得・更新・解除を拒否、未認証・偽装管理権限・未知入力の拒否、全体とプランの
上限縮小整合性、トランザクション途中失敗のロールバック、DB読取り失敗、
手動移動中の障害による部分移動の禁止、同時手動移動・残り1枠への競合、
明示移動時だけ後順位プール選択可、新規登録の優先順位維持、管理者による所有者の枠を
使った移動、旧確認間隔の明示オプション、監査ログ、孤立・二重割当・不正プール検出。

## 証拠の範囲

ローカルMariaDBでの枠割当・設定・認可・永続化試験は、実Firefox購読移譲、実X通知受信、
Discord送達、本番プラン行・支援履歴の確認、本番マイグレーション、本番デプロイの証拠を
含まない。それらの受入は既存G1・運用ゲートと別に記録する。

管理者・利用者UI、最終統合回帰、マイグレーション／ロールバックの受入は、
上記のDOM・実DB証拠および移行／切り戻し文書でローカル合格。
実Firefox専用プロファイル抽出、実X通知受信・復号、Discord実送達、Mozilla運用許容性は
未検証。登録は既定で無効、本番DB変更・デプロイ・決済有効化は行っていないため、
新自動展開システム全体の本番提供完了とは扱わない。

