# main 再監査で見つかった追加10件の修正状況

<!-- LOCAL_ACCEPTANCE_STATUS_BEGIN -->
2026年10月16日。追加10件の修正は、固定ソース `f915a68819b38b01664a3bde25770c46eda7bcbc` に対する個別テストと独立レビューを通過しました。rootは同じソースの184試験ファイルを実行中です。全体の最終件数と合否、mainへの統合、支援者限定の本番反映は、まだ確定していません。
<!-- LOCAL_ACCEPTANCE_STATUS_END -->

監査対象は `2a000c89a293e2ee71ef0c579a63def2ff12cbdb` です。従来の53件とは別に、この文書で追加10件を管理します。既存の53件の報告書、対応表、テストXMLと、今回の監査原本8ファイルは保持しています。

対応表の機械可読版は [main-reaudit-remediation.json](main-reaudit-remediation.json) です。コードとテストの宣言位置を各IDに対応付けています。runtimeの修正中に記録した位置は、最終ソースの固定後に再確認します。

## 10件の対応

| ID | 修正内容 | 現時点の検証 |
|---|---|---|
| MAIN-UI-1 | 通知の種類とIDを組み合わせて下書きを照合。同じ数値IDの価格通知を削除しても、新着通知の未保存入力を保持する。 | 種類をまたぐ削除、削除失敗、停止、同じ種類の削除を実Reactで確認。独立レビュー済み。 |
| MAIN-UI-2 / MAIN-FRESH-1 | 確認間隔の再取得で全ページをたどり、101件目以降の登録も最新の間隔とCAS基準へ更新。保存後の取得失敗時は、再取得が成功するまで保存の再送を防ぐ。 | 2ページ目の保存後に続けて保存できること、null・例外からの回復、読込済み一覧と入力の保持を確認。独立レビュー済み。 |
| MAIN-FRESH-2 | ルールの変更履歴に版番号のkeysetページングを追加。従来の配列応答も保持し、100版での切捨てを解消。 | 実SQLで102版を取得。初回取得前の新版103、途中の新版追加、循環cursor、DB障害、選択切替、最古版の復元を確認。独立レビュー済み。 |
| MAIN-FRESH-3 | X一覧の読込世代と保存処理の識別を分離。無関係な受信情報の更新や遅い読込が、確定済みの監視作成・編集・停止・再開を取り消さないようにした。 | 4操作について、即時応答と遅延応答の両方を実Reactで確認。次の編集が最新CASを使うことも確認。独立レビュー済み。 |
| MAIN-DATA-1 | Push枠の決済履歴を現在のSquare環境・加盟店・利用者で絞り、cursorにも同じ範囲を固定。画面にも決済範囲を表示する。 | 別環境・別加盟店・別利用者の除外、不正cursor、認可、SQL障害、資格情報の一時停止、ページ途中の範囲変更を実API・SQL・Reactで確認。独立レビュー済み。 |
| MAIN-DATA-2 | 通報の解決、CAS検証、監査記録を同じトランザクションで確定する。 | 監査INSERTとcommitの失敗時に未解決へ戻ること、同時操作で状態と監査が一度だけ確定することを確認。独立レビュー済み。 |
| MAIN-POST-1 | クーポン・通知プランの保存応答が届いた時点で、それ以前の親一覧読込を無効化。同じAPI内では版を後退させず、別APIでは同じIDの古い時刻を正しく採用する。 | 実React・API・SQLで、保存前に始まった一覧の成功・失敗を遅延させて確認。別APIの同一IDと小さい更新時刻も確認。独立レビュー済み。 |
| MAIN-POST-2 | 通報に、表示していた版番号とchecksumを保存。審査画面はその版を開き、旧通報の不明な対象版を推測しない。 | 新版公開、非公開、撤回・失効後も正しい通報対象を管理者が確認できること、対象版の偽装拒否、理由更新と解決のCASを確認。独立レビュー済み。 |
| MAIN-FRESH-4 / MAIN-RUNTIME-MIXED | 配信履歴を全枝の状態から決定し、SQLの行順で結果が変わる問題を修正。送信済みと失敗の混在を「一部送信」として扱う。 | 実分岐runnerと144通りの状態組合せに加え、追加の競合修正も個別テストと独立レビューを通過。最終ソースの全体試験は実行中。 |
| MAIN-FRESH-5 | cancel・retry・reschedule・lease回収など、jobを直接変更する経路でrun履歴も同じトランザクション内に更新する。 | 初期jobが0件の場合の削除・安全停止と、監視を別ルールへ移す際の競合を修正。最終16件と独立した増分2件が成功。全体試験は実行中。 |

最終の独立レビューは、29ファイルのGit原文と作業ファイルのハッシュを照合しています。前段の8件の証拠とruntimeの修正履歴も保持し、最終ソースの全体テストとは区別します。

## 受入候補から外した中間ソース

`fdde3bd98bee5774eea0aac59466a5d7656a0c42` は、今回の最終受入ソースではありません。

MAIN-FRESH-5の独立したv4再現試験では、次の順序で実SQLの `ER_LOCK_DEADLOCK` が発生しました。

1. 2枝の送信意図がある一方、jobはまだ存在しない状態で、ルール削除が候補一覧を読む。
2. 別のprojectorが1枝目のjobを作る。
3. 削除処理と2枝目のprojectorが、それぞれgraphとjobの更新へ進む。
4. 削除は確定するが、projectorのトランザクションがdeadlockで失敗する。

トランザクションのロールバックは機能しており、この再現ではデータ消失、二重送信、恒久的な停止は確認されていません。通常の同時操作が失敗するため、受入候補から外しています。これはMAIN-FRESH-5の追加修正であり、11件目としては数えません。

修正では既存の `automation_flow_locks` にworkflow単位の共有・排他ロックを設け、初回jobが存在する前から管理操作とgraph処理の順序をそろえます。ルール削除だけでなく、共有パッケージの安全停止、利用者・通知先・設定の現在値確認も対象です。この修正と、続いて再現した監視の割当先変更と安全停止の競合は、固定f915の個別テストと独立レビューを通過しました。namespace一覧は、可変のflow-run行を先にロックせず、immutableなunit/memberと実行元から取得します。新しいテーブルやDDLは追加していません。

詳細は [独立runtimeレビュー](main-reaudit-evidence/independent-runtime-fdde-followup.json)、[v4再現結果](main-reaudit-evidence/independent-runtime-delete-project-race-v4-result.json)、[失敗を保持したXML](main-reaudit-evidence/independent-runtime-delete-project-race-v4.xml) に記録しています。

## テスト証拠の範囲

| 証拠 | 結果 | 判定範囲 |
|---|---|---|
| UI担当の固定した5ファイル | 28件成功、失敗・skip 0 | UIの5指摘。[XML](main-reaudit-evidence/ui-author-focused-28.xml)、[担当報告](main-reaudit-evidence/ui-author-focused-report.json) |
| データ担当の4ファイル | 57件成功、失敗・skip 0 | データの3指摘と関連回帰。[担当報告](main-reaudit-evidence/data-author-focused-report.json) |
| UI・データ8件の独立レビュー | 43件と追加境界3件が成功 | 記録された内容に対する8件の判定。[報告](main-reaudit-evidence/independent-eight-id-report.json)、[43件XML](main-reaudit-evidence/independent-eight-id-focused-43.xml)、[境界3件XML](main-reaudit-evidence/independent-eight-id-boundaries-3.xml) |
| 中間runtimeの担当試験 | 42件成功 | 後続の独立再現で候補を棄却したため、全体受入には使わない。[担当報告](main-reaudit-evidence/runtime-author-fdde-superseded-report.json) |
| 中間runtimeの独立試験 | 58件と境界2件が成功。その後、v4の1件がdeadlockで失敗 | 成功群だけを抜き出してruntime全体の合格とは扱わない。[レビュー](main-reaudit-evidence/independent-runtime-fdde-followup.json) |

最終f915の[担当16件](main-reaudit-evidence/runtime-author-final-f915-16.xml)と、実監視の割当変更・安全停止および逆順runtime先行を再現した独立した増分2件は成功しています。[最終独立レビュー](main-reaudit-evidence/independent-final-f915-incremental.json)は、前段d6の83成功を別ソースの証拠として保持し、変更2ファイルと残る27ファイルの一致を確認しています。旧d6でdeadlockを再現した[元のXML](main-reaudit-evidence/runtime-monitor-revoke-d6-red.xml)も保存しました。

<!-- ROOT_MATRIX_RESULT_BEGIN -->
全体受入試験は固定f915の184ファイルで実行中です。進行中XMLは受入結果として扱いません。最終成功件数・失敗件数・skip・cancel・todoは対応表で `null` とし、終了コード0をrootが確認した後に確定します。個別テストや別ソースの成功件数は合算しません。mainのSHA、本番反映SHA、実bundle承認も未確定です。
<!-- ROOT_MATRIX_RESULT_END -->

次の診断結果も、成功扱いに置き換えず保持しています。

- データ関連123件の確認は122件成功、1件が使い捨てschema構築時のTCP接続 `ETIMEDOUT` でした。migrationや製品のassertionに到達する前の失敗です。該当試験の隔離再実行は1件成功しました。接続障害の環境上の原因は未特定であり、123件すべて成功とは記録しません。[元のXML](main-reaudit-evidence/data-adjacent-123-diagnostic.xml)
- 独立cursor試験の初期fixtureは、決済cursorの検証前に行われる別途scope済みの支援枠SELECTまで禁止していました。修正版はそのSELECTを認め、不正cursor時に決済SELECTが0件であることを検証しています。[初期XML](main-reaudit-evidence/independent-boundaries-first-fixture-diagnostic.xml)
- runtimeの初期性能試験、古い期待値の修正、v1・v2・v3の不適切なrace fixtureは担当・独立報告で区別しています。最終的に実SQLでdeadlockへ到達したv4だけが、今回の追加修正を要求する再現証拠です。

## 画面で確認した範囲

rootによるローカルの画面確認では、実React、実サービスAPI、使い捨てMariaDBを接続し、変更履歴を50件、100件、102件まで読み込みました。版2・版1へ到達し、版1を復元して新しい下書き版103になることを確認しています。[操作結果](main-reaudit-evidence/browser-history-fdde-scenario.json)

![版1を復元した変更履歴画面。ローカルのテスト環境で、Discordは模擬。](main-reaudit-evidence/history-restored-desktop-fdde.jpg)

画面確認時のソースは中間版 `fdde3bd98bee5774eea0aac59466a5d7656a0c42` です。この証拠はUIの対象経路に限ります。最終f915でも対象の6 UIコンポーネントが不変であることを確認して、このローカルUI経路の証拠を引き継ぎます。追加runtime修正のブラウザー再試験や、本番での動作確認を示すものではありません。確認に使用したブラウザーと専用harnessは終了し、専用schemaも削除済みです。

## 最終判定までに必要な確認

<!-- FINAL_LOCAL_GATE_BEGIN -->
- 固定f915に対する全体184ファイルの実行を完了し、閉じたXMLと最終summary、コード・テストのハッシュから件数と合否を確定する。
<!-- FINAL_LOCAL_GATE_END -->
- 最終ソースと画面確認済みのUI・APIの内容を比較し、対象経路が変わった場合は画面を再確認する。
- mainへの統合後のSHAと、検証した製品ソースの対応を確認する。
- V8の実配布物と展開手順を最終ソースに対して審査し、支援者限定の本番反映後にresidentのSHA、全シャード、lease、heartbeat、アプリの初期化、既存X受信の接続を確認する。
- 既存データ、通知・課金設定、通常の30分設定と個別の5分設定を維持し、復旧手順の検証結果を残す。

V8は手順の準備段階です。今回の10件を修正したソースの本番反映は、まだ行っていません。rootの2026年10月16日07:56 UTCの読み取り確認では、本番は既存の `c63003f5dbd585a3f09e8672a0f80fa5db460165`、支援者限定、全14シャードreadyでした。この文書作成で本番データや稼働サービスへの変更は行っていません。

実OAuth、新しい実X投稿からDiscordへの配信、実Square決済は未検証です。fixtureやローカル画面の証拠とは区別して記録します。
