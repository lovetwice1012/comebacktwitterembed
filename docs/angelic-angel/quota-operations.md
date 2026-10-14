# X監視枠の設計・運用・切り戻し

2026-10-14 JST。最新制度は `quota-allocation-spec.md`。本手順の記載は本番操作の承認を意味しない。

## 保存先と既存機能

既存 `automation_notification_plans` にnullableな確認間隔を追加する。auto/price/Xは既存 `automation_notification_slots` を共有し、短縮用boostも従来どおり使用枠に含める。停止中も予約を保持する。

| 保存先 | 追加理由 |
|---|---|
| `automation_push_pool_policy` / `automation_push_plan_policy` | 個人上限とは異なる共有容量とプラン特殊資格を保存。全体容量行を競合制御ロックにも使用 |
| `automation_x_monitors` | 既存auto/priceの取得周期とは異なる利用者/Xアカウントの予約・pool・通知設定・購読状態を保存。新受信サービスではない |
| 支援4台帳テーブル | 既存の期限付き金融集計で表せない永久保有、旧制度分類、決済再送防止を保存。詳細は `support-grant-migration.md` |

認証は既存NextAuth/Discord、所有者照合、実管理者、origin/CSRF、fleet書込権限を使う。決済は既存Squareの署名検証/REST再照合だけで観測し、新決済サービス・受付自動有効化は追加しない。

## 原子性

Xの登録・解除・手動移動・プラン変更は全体容量行→所有者行の順にロックする。通常通知は所有者だけをロックし、後からX全体ロックを取らない。Square観測は既存ポリシー→所有者→付与/集計の順とし、管理操作との逆順を避ける。

全体占有と容量縮小の確認はロック付きcurrent readで行う。古いMVCCスナップショットを持つ管理トランザクションでも直前に確定した登録を数える。予約・設定変更・監査は同一トランザクションで保存し、途中失敗をrollbackする。DBに破損容量がある場合は空き容量として使わず、診断に `INVALID_POOL_POLICY` を出す。

新規は個人空き確認後に無料→保有支援/全体支援→契約プラン特殊枠の順で割り当てる。再送は二重作成せず、同じXを別所有者が登録すれば各1件数える。

手動移動は登録ID・任意の移動先・revisionを送る。サーバーで所有者/管理者、対象所有者の資格、種別上限、個人上限、移動先空きを確認し、単一UPDATEでpoolを変更する。対象・通知設定・個人枠ID・購読状態・利用者の有効/停止設定を保持する。新規優先順位を手動選択へ適用しない。

`reconcile` / `recheckAll` は資格を再評価してready/suspendedを変更するだけ。空き、解除、プラン変更、上限変更でpoolを変更しない。自動再配置API/ボタンは設けない。資格失効登録は元のpoolと個人予約を占有し、明示移動または解除を待つ。

## 画面・監査

`/admin/notification-plans` で既存プラン確認間隔、無料/支援共有上限、プラン特殊資格/上限を設定する。同画面の診断で保有数、全体使用数、各登録種別、支援/決済/付与全履歴、管理者の手動移動を確認する。実使用数未満の容量縮小は拒否する。特殊資格を取り消す変更は登録を停止し、予約は削除しない。

個人通知管理のX欄は必要時に開く。実登録件数とboost込みの使用枠数を分け、提供停止・個人上限・全体満枠の理由を区別する。内部種別は移動先選択など必要な場所へ限る。

`automation_audit` に割当、解除、明示移動、資格停止/復帰、容量変更、支援付与を保存する。通知鍵、Cookie、要求本文を監査へ入れない。破損設定はID/診断コードだけを管理画面へ返す。DB障害は破損に読み替えず失敗を伝える。診断は修復/移行/削除をせず、孤立・重複・不正資格・上限超過を報告する。

## マイグレーション

1. 本番変更承認後、plans/entitlements/slots/boost、usersの旧付与数、Square決済/集計、監査をバックアップする。旧購入回数と既存付与を照合し、不明な数を金額から生成しない。
2. 新X受付・受信を停止したまま、既存schema作成と `migrations/20261014_add_plan_confirmation_interval.sql` を通常の移行経路で適用する。既存行への一括上書きはしない。DDLのautocommit境界とデータ切り替えを区別する。
3. interval列はnullable追加で、既存の名前・基本上限・品質設定を保持する。管理者が実プラン別間隔・特殊資格/数を明示設定する。プラン名や価格から未定義値を推測しない。
4. 支援移行は `support-grant-migration.md` に従い、利用者/決済scopeごとに旧数を保全する。旧版/新版の決済書込みを混在させず、新決済前のsnapshotを飛ばさない。
5. 既存通知の予約ID、対象、設定、確認間隔、支援保有数を前後照合し、診断を実行する。異常行は削除せず根拠を確認する。再実行で付与・移動を増やさない。
6. G1と提供承認が揃うまで `ANGELIC_X_REGISTRATION_ENABLED` は設定しない。容量編集・台帳移行は実受信や課金受付の開始ではない。

## 切り戻し・障害

`ANGELIC_X_REGISTRATION_ENABLED` を解除して新X受付を停止する。既存の閲覧・停止・解除・明示移動と永久保有参照は残す。追加テーブル/列、登録、台帳、枠、監査をdropしない。将来の実受信/配送も運用手順に従って停止する。

X予約や永久追加を読めない旧版への直接切り戻しは個人上限と既得権を壊すため、その版を切り戻し先に使わない。台帳とX kindを保持する互換版または提供停止した現版を使い、保全記録・バックアップ・監査で復旧する。移動失敗は元割当を保持し、画面は入力を保持して再取得を促す。資格失効や満枠を登録削除の理由にしない。

返金後の永久枠失効は未定義のため金融レビュー情報のみ記録し、自動失効を追加しない。`ANGELIC_X_USE_LEGACY_USER_INTERVAL=1` は明示互換/テスト設定で、既存利用者別間隔を参照する。標準は契約プラン間隔、未設定へ固定値を補わず、クライアントから切替を許可しない。

## 試験再現

DB試験は明示した非本番ポートで直列実行する。fixtureは127.0.0.1・3306以外・ランダムguarded schemaを要求し、終了時はそのschemaだけを削除する。

```powershell
$env:AUTOMATION_TEST_DB_PORT='33621'
node --test --test-concurrency=1 --test-timeout=180000 --test-reporter=junit --test-reporter-destination=docs/angelic-angel/quota-allocation-tests.xml scripts/test/automation-x-quota-sql.test.js scripts/test/automation-push-support-grants-sql.test.js scripts/test/automation-x-quota-migration.test.js scripts/test/automation-push-capacity-sql.test.js scripts/test/automation-plan-admin-sql.test.js scripts/test/automation-entitlements-sql.test.js scripts/test/automation-square-donations-sql.test.js scripts/test/automation-square-billing-sql.test.js scripts/test/automation-monitor-cadence-sql.test.js scripts/test/automation-monitor-cadence-lifecycle-sql.test.js
node --test --test-concurrency=1 --test-reporter=junit --test-reporter-destination=docs/angelic-angel/quota-ui-tests.xml scripts/test/automation-donation-ui.test.js scripts/test/automation-plan-admin-ui.test.js scripts/test/automation-square-commerce-ui.test.js scripts/test/automation-push-capacity-ui.test.js scripts/test/automation-x-monitor-ui.test.js scripts/test/automation-notification-quota-ui.test.js scripts/test/automation-monitor-cadence-ui.test.js
```

17要件対応は `quota-acceptance-matrix.md`、ソースSHA256・確定集計は `quota-validation.json`。実Firefox/X、実Discord、本番UI/DB/移行、実課金はfixture証拠に含めない。
