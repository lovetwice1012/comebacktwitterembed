# Angelic Angel 実装状況

更新: 2026-10-14 JST。ブランチ: `codex/angelic-angel-node-port`。

Phase 0のローカル互換性ゲートG0は合格。追加枠制度は既存DB・認証・プラン画面に実装し、最新指示に合わせて**自動再配置を撤廃**した。新規は無料→支援者→特殊、既存の移動は所有者または実管理者の明示操作だけとする。

利用者向けに、日本語GUIのローカルファイル作成クライアントを追加した。ダブルクリックで説明画面を開き、
専用Firefoxの通知情報を保護した新規ファイルへ保存する。アップロードは本人の手動操作とし、ツールから送信しない。
Firefoxの実保存形式に合成通知を保存したnative試験で、両PowerShellの抽出・原本保持・cleanupを検証済み。
実X購読・実通知のG1合格とは別である。詳細と配布物は `powershell-file-client.md`。

専用の個人向け `/dashboard/automation/x` と既存画面からの導線を追加した。説明、配布ZIP取得、同意、手動ファイル選択、サーバー検証、公開鍵による暗号化保存、本人による削除までをローカル統合する。受付は明示設定までOFFで、保存済みと実受信開始を区別する。`x-notification-onboarding.md` にAPI・鍵管理・追加DDL・切り戻しを記載する。

システム全体の本番受入は未完了。実Firefox購読移譲・実X通知受信復号のG1が未達で、新規X登録は既定で無効。本番DB変更、デプロイ、決済受付有効化、実通知送信は行っていない。

過去の「枝分かれ · GitHub実装レビュー」を冒頭から再照合し、`history-reconciliation.md` に決定・訂正を記録した。共通の支援者先行提供判定、受信情報と監視対象の紐付け、永続lease/inbox、保存後ACK、復旧supervisor、既存queue/graph/transportへの接続を追加した。2026-10-14 JSTの追加回答「原則1」で、プラン間隔ごとの全件まとめ処理 `batch` を標準・既定に確定した。詳細は `server-receiver.md`。実X形式・実受信の検証は残り、この決定を提供開始と読み替えない。

## 工程別の結果

| 工程 | 結果 | 証拠と範囲 |
|---|---|---|
| Phase 0 Rust→Node.js/TypeScript | ローカルG0合格 | 全8モジュール、13組の実Rust差分比較、72暗号fixture、199件成功。Rust参照14ファイルSHA256一致。`phase-0-acceptance.md` |
| 独立PoC | 合成データ・loopback部分の41件合格 | `experiments/angelic-push/`。実Firefox/Xの証明ではない |
| 枠管理・支援台帳・確認間隔 | ローカル実装・受入 | 原子的な登録/解除/手動移動、同時実行、認可、旧付与数保持、永久付与、決済再送、監査、停止中占有、実DB永続化 |
| 管理者・利用者画面 | DOM操作・既存画面の回帰確認 | 容量設定、履歴ページング、診断、手動移動、登録件数と使用枠数の区別。既存プラン/決済/利用者間隔の操作維持 |
| 移行・切り戻し | disposable DBで確認 | nullable列追加、再実行、旧値保持、提供停止後の台帳/登録保持。`quota-operations.md` と `support-grant-migration.md` |
| ファイル登録画面・暗号化保管 | ローカル統合・fixture受入 | 所有者ワンタイム登録、厳密な入力、公開鍵envelope、二重保存/IDOR/DB障害検証。実X購読の有効性は未確認 |
| サーバー受信・ルール配送への接続 | ローカル実装・合成/loopback試験 | 永続lease/inbox、保存後ACK、復旧、既存queue/graph/transport。実X形式・実購読は未確認 |
| 実Firefox/X受信・本番配送 | 未検証・G1未達 | 合成fixtureを実X受信や本番配送の成功と読み替えない |
| 本番プラン・旧支援履歴の照合 | 未実施 | 本番Basic行はユーザー申告。実プランIDを参照する実装で、実データ照合・移行は承認後 |

## 追加制度

- 全体の無料50・支援者100は独立した共有プール。管理者のプラン変更画面で上限を編集する。特殊枠は既存の有料プラン行に紐付く資格・利用者別上限。未設定は0とし、プラン名・価格からBasic以上を推測しない。
- 通常auto/priceとXは既存 `automation_notification_slots` を共有。個人上限は既存のサーバー管理プラン基本上限＋正規の支援者追加保有数。短縮用boostも従来どおり消費し、画面では登録件数と物理使用枠数を区別する。
- 旧商品は信頼できる既存付与数を保持し、金額を500円で割らない。新規の検証済みJPY決済は1決済ごとに500円につき1枠を永久付与する。旧Squareの金融倍率・期限付き集計を新永久枠へ重ねて加算しない。
- 既存の支援者専用基本上限も登録権利として維持する。Xの品質は無料契約または現在の有料契約から参照し、支援者資格・プールを品質選択に使わない。
- プラン確認間隔は任意のnullable列 `confirmation_interval_minutes` を追加。未設定へ固定値を補わない。既存利用者別の設定・実装も保持し、サーバーの明示互換設定でテストに使用できる。
- 受信後の処理は `batch` のみ対応し、現在の契約プランの確認間隔ごとにwindow内の保持通知を全件処理する。処理方式の回答待ちは解決済みで、実プラン間隔の未設定は引き続き処理待ちとする。rollout・ファイル受付・登録受付・受信Workerの既定OFFは維持する。
- リアルタイムは将来のオプション案で、実装する場合の対象条件案は「Basic以上」の「+」プラン限定。未実装で、具体的なプランID・提供時期・価格・申込方法は未決定。追加する場合は明示したサーバーのプラン設定・feature entitlementを使い、プラン名や末尾 `+` から判定しない。
- 解除、空き、上限変更、プラン変更では既存poolを変えない。資格失効時は停止し、元の割当・個人枠・設定・購読状態を保持。停止中も占有として数える。実使用数未満への容量縮小は拒否する。
- 手動移動は任意の移動先を選べる。所有者の資格・移動先空き・個人上限をサーバー検証し、単一トランザクションで移動する。対象・設定・個人枠ID・購読状態・プラン由来品質を保持する。

詳細は `quota-allocation-spec.md`、17項目対応は `quota-acceptance-matrix.md`。

## 最終検証

| 証拠 | 結果 |
|---|---|
| `phase-0-tests.xml` | 199成功、失敗・スキップ・TODO 0。同日の枠実装前に実Rust比較を再確認 |
| `quota-allocation-tests.xml` | 198成功、失敗・スキップ・TODO 0。枠・台帳・既存プラン/支援/課金/間隔の実DB統合試験 |
| `quota-ui-tests.xml` | 131成功、失敗・スキップ・TODO 0。管理者/所有者/支援/プラン/決済/通知枠/間隔のDOM試験 |
| `quota-command-tests.xml` | 3成功、失敗・スキップ・TODO 0。既存Discord支援追加コマンドの権限・トランザクション・冪等な監査経路 |
| `onboarding-tests.xml` | 156成功、失敗・スキップ・TODO 0。Web登録・RSA公開鍵envelope・DB同時実行/障害・既存X枠・通常通知/料金導線・配布ツール回帰 |
| `onboarding-native-tests.xml` | 5成功、失敗・スキップ・TODO 0。合成recordを使う実Gecko→両PowerShell/GUI出力→新Web validator、原本保持・cleanup |
| `onboarding-browser/browser.json` | 10項目成功。実React→HTTP fixture→共通API→一時DB、手動確認・暗号文・再起動・削除。PC/390px表示、外部通信・ページ例外0 |
| `history-reimplementation-tests.xml` | 39ファイル・574成功、失敗・スキップ・TODO 0。過去要件の再実装、受信/復旧/既存配送、支援者先行、紐付け、通常通知・料金・管理画面の回帰 |
| `history-worker-config-tests.xml` | 当時の3成功、失敗・スキップ・TODO 0。無効時の秘密鍵未参照、異常設定、Worker専用鍵、回答前の処理方式未設定時のゼロI/O。`batch` 既定化前の証拠として保持 |
| `cadence-batch-tests.xml` | 160成功、失敗・スキップ・TODO 0。標準の全件まとめ処理、所有者ロック内での現プラン間隔確定、再起動・プラン変更・未処理保持、画面・通知処理の回帰。`cadence-batch-validation.json` |
| `experiments/angelic-push/test-results.xml` | 41成功、失敗・スキップ・TODO 0。合成・loopbackのみ |
| root / Dashboard | typecheck・lint成功。変更対象・ソースSHA256と確定結果は `quota-validation.json` |

DB試験は明示した `127.0.0.1:33621` の一時MariaDBのランダムguarded schemaだけで直列実行した。競合試験はその実DB上で独立トランザクションを同時実行する。Square REST/Webhookと画面応答はfixtureで、実課金・実通知の証明ではない。

最終再試験の一度でNode子プロセスが開始時にWindows終了コード3221226505で終了した。該当entitlements試験の同じコマンドによる単体9件は成功し、コード変更なしの統合198件も成功。その後の破損容量fail-closed修正を含む最終198件は75.6秒で成功した。失敗原本は `quota-allocation-tests-startup-failure.xml` に保存。当時は原因未特定で、その失敗を成功に読み替えていない。現在の原因特定と修正は後続節に記録する。

Phase 0は `130858c`、例外原因の秘密情報除去は `762c2a4`。枠管理は作業ツリーでレビュー可能。以前からあるBot・Dashboard・決済等の未コミット作業を保持した。

Worker設定テストの最初の1件はfixtureにDBメソッドを用意していなかったため構成検証で失敗した。fixtureを修正して3件成功。初回の結果も `history-worker-config-tests-initial.xml` に保持した。本番コードをテスト成功用に緩めていない。

まとめ処理の初回一式では、既存entitlements SQLテストのNode子プロセスが開始時にWindows終了コード3221226505で異常終了した。他151件は成功したが、一式の成功とは扱わず `cadence-batch-tests-initial.xml` を保存。同じコードの該当単体9件が成功し、続けて同じ一式160件も成功した。当時の原因未特定という記録は、以下の追加調査で解消した。

## 2026-10-14 後続修正：Node異常と他サイト混在

依存なしのloopback再現と例外ダンプにより、旧Node24.15.0のWindows TCP処理でstack cookie failureを確認した。
`OSVERSIONINFOW` のサイズ未初期化を修正した公式版24.21.0をプロジェクト用に固定し、検証済み起動器とセットアップを追加した。
原因・一次資料・初回失敗と最終試験の区別は `node-startup-diagnosis.md`、シンボル照合は `node-startup-native-analysis.txt`。
過去の失敗XML・JSONは変更しない。

他サイト混在の一律拒否は最新指示で撤回した。Xだけの文書を同じスナップショットから作り、片付け後・出力前に
サーバーへの他サイト通知の到着可能性、技術的な取得可能性、別途許可までの破棄、Firefoxへ届かない可能性を説明して確認する。
X以外の鍵を出力せず、サーバーも未知CHIDの有効なフレームをACK102で破棄し、X接続を維持する。
`0.1.0-preview.3` とWebのダウンロード固定値を一致させる。詳細は `powershell-file-client.md` と `x-notification-onboarding.md`。

最終検証：Node旧版/新版の同一fixture各1,000回は旧版2件native異常、新版0件。固定版でPhase0の199件、
X・枠管理・通常通知等の回帰623件、起動・配布ツールの最終54件、実Gecko合成fixture6件が成功した。
Web実ブラウザーは11チェック成功、例外・外部通信は0。各集合には重複があるため合算しない。
`mixed-notification-validation.json` が最終ソースhashと受入証拠をまとめる。
本番データ・稼働中サービス・実X購読・有料決済は変更していない。

## 残る受入

2026-10-14の説明文改稿版は `0.1.0-preview.4`。保存ツール、登録・監視・枠変更画面、同梱ガイドを肯定的で具体的な文章に整理した。
最新版の文章と配布・画面の確認結果は `positive-copy-review.md` / `positive-copy-validation.json`。
上記のpreview.3検証記録と旧配布物は履歴として保持する。

G1には指定した専用Firefox環境、手動X通知設定、監査可能なPush限定export、同一UAIDの移譲、実X通知復号、Mozilla/Xの運用条件確認が必要。合成fixtureやソース調査から成功を推定しない。

説明画面・所有者nonce・公開鍵暗号化、サーバー受信/復旧/配送経路のコードはローカルfixtureで検証する。G1と運用承認後に、実購読を使うonboardingと実通知・長期運用の受入へ進む。今回のコード接続だけで新機能全体、本番提供、支援者betaを完了扱いにしない。
