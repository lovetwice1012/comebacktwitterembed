# main 再監査で見つかった追加10件の修正状況

<!-- LOCAL_ACCEPTANCE_STATUS_BEGIN -->
2026年10月16日。D2ソースの全185試験ファイルは2,151件成功、失敗・skip・cancel・todo 0件、native終了コード0でした。最終コード候補は整形・JSDocだけを変えたF（e88e744）です。全体試験を実行したのはD2であり、Fで全体を再実行したとは記録しません。rootは厳密な等価証拠でD2結果をFへ引き継ぐ方針を決めました。最終F証明とREV4のローカル202件を待ち、main・実bundle・本番は未確定です。
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

| MAIN-FRESH-4 / MAIN-RUNTIME-MIXED | 配信履歴を全枝の状態から決定し、SQLの行順で結果が変わる問題を修正。送信済みと失敗の混在を「一部送信」として扱う。 | 実分岐runnerと144通りの状態組合せに加え、追加の競合修正も個別テストと独立レビューを通過。旧全体の失敗を保持し、d2の個別テストと独立レビューは成功。185ファイル全体は実行中。 |

| MAIN-FRESH-5 | cancel・retry・reschedule・lease回収など、jobを直接変更する経路でrun履歴も同じトランザクション内に更新する。 | 初期jobが0件の場合の削除・安全停止と、監視を別ルールへ移す際の競合を修正。最終16件と独立した増分2件が成功。親子jobの同時後始末とUUIDの内部照合をd2で修正。個別・独立試験成功、全体185ファイルは実行中。 |

旧f915の独立レビューは、29ファイルのGit原文と作業ファイルのハッシュを照合した個別の証拠です。今回のfixture修正と整形を含む0769は、独立レビューv2で30ファイルと8 CORE treeを確認済みです。旧ソースの個別成功と、未完了の全体試験を区別して記録します。

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
[D2の閉じた全体XML](main-reaudit-evidence/root-d2-full185-2151-tests.xml)は185ファイル、2,151件成功です。内訳はleaf 2,090件と親61件で、失敗・skip・cancel・todoは0件。[最終summary](main-reaudit-evidence/root-d2-full185-2151-progress.log)と[native終了receipt](main-reaudit-evidence/root-d2-full185-native-exit.json)も照合し、終了コード0を確認しました。[rootの結果記録](main-reaudit-evidence/root-d2-185-closed-acceptance.json)は実行ソースをD2としています。safeなDB取得のretryはspecに1回、outerに0回で、同じ経路の記録を合算していません。

最終コードF=e88e74412905987352af0ae7cec665963fc737d0では、この185ファイル全体を実行していません。D2の結果は[等価性に基づく引継ぎ計画](main-reaudit-evidence/independent-closed-D2-format-carry-plan.json)と、Fの追加確認を組み合わせて扱います。XML名・実行SHAを書き換えず、失敗した旧試験の履歴も残します。
<!-- ROOT_MATRIX_RESULT_END -->

### 旧0769の全体試験は不合格

固定0769のrun 47219は終了コード1で終了しました。全184ファイル、2,126件中2,120件成功・6件失敗、skip・cancel・todo 0件、実行時間1,311,051.6327msです。[閉じた失敗XML](main-reaudit-evidence/root-0769-closed-failed-184-tests.xml)、[最終ログ](main-reaudit-evidence/root-0769-closed-failed-184-progress.log)、[診断結果](main-reaudit-evidence/root-0769-closed-failure-diagnostic.json)を保存しました。これは全体の不合格であり、成功した2,120件を部分的な受入結果として扱いません。

失敗6件は、実際の原因4件と、その失敗を受けた親テスト2件です。3件は使い捨てDBの接続・管理接続・DDL取得に入る前のnative TCP `ETIMEDOUT`（errno -4039）でした。製品のassertionへ進む前の接続取得失敗ですが、環境上の根本原因まで特定したことにはしません。残る1件は製品の回帰で、旧形式のheld親jobがfailedになった同じclaim呼出しで、子jobがaggregatedのまま残りました。`automation-sql.test.js:207` の既存の期待値は保持し、親子を同じトランザクションで整合させる修正を行います。

テスト用DB helperではnative TCP取得だけを最大3回試行し、安全な診断を記録する変更を進めます。製品SQLやトランザクションの再実行を加える修正ではありません。担当は19件のunit試験も追加していますが、いずれも新しいソースと全体試験の成功としてはまだ記録しません。変更対象32パス・185試験ファイルは準備時の見込みで、最終値は固定ソースと実行結果から確定します。

実行前の文書は[対応表](main-reaudit-evidence/historical-0769-reviewed-running-map.json)と[報告書](main-reaudit-evidence/historical-0769-reviewed-running-report.md)として先に保存しました。d207 finalizerは実行禁止です。新しいソース、manifest、独立証拠、新しい全体試験の実際の終了コード0を確認するまで、次のfinalizerは準備しません。main、本番、実bundleの承認は未確定です。

### 旧f915全体試験の診断

固定f915の184ファイルを対象にしたrun 19271は、終了コード1で停止し、全体の実行を終えていません。閉じていないXMLと途中のログは[未完了XML](main-reaudit-evidence/root-f915-failed-incomplete-tests.xml)と[進行ログ](main-reaudit-evidence/root-f915-failed-incomplete-progress.log)として保存しました。[有効な診断記録v2](main-reaudit-evidence/root-f915-failed-diagnostic-v2.json)を根拠とし、先に作られたnullの診断ファイルは[無効な記録](main-reaudit-evidence/root-f915-invalid-null-diagnostic.json)として保持しています。最終件数は算出せず、対応表の成功・失敗・skip・cancel・todoは `null` のままです。

問題のテストは、新しい送信処理が先にowner/workflowロックを取ったまま、割当変更側のtargetロック到達を待っていました。割当変更側は同じownerロックを待つため、JavaScriptの待ち合わせが解決しません。この停止は実InnoDB deadlockの再現や、データ消失・二重送信の証拠ではありません。旧fixtureを実際のownerロックの直列化試験へ置き換え、物理送信前の実SQL deadlockは別の2行競合試験として残します。

旧f915の文書下書きは、更新前のバイトを[対応表](main-reaudit-evidence/historical-f915-pending-map.json)と[報告書](main-reaudit-evidence/historical-f915-pending-report.md)として保存しました。旧finalizerは[静的レビュー](main-reaudit-evidence/f915-retired-finalizer-static-review.json)を通過していますが、run 19271が失敗・未完了のため、実行しません。後続の0769では、新しいSHA・manifest・独立証拠・root実行IDを記録し、別のガード付きfinalizerを準備しています。main、本番、実bundleの承認は未確定です。

次の診断結果も、成功扱いに置き換えず保持しています。

- データ関連123件の確認は122件成功、1件が使い捨てschema構築時のTCP接続 `ETIMEDOUT` でした。migrationや製品のassertionに到達する前の失敗です。該当試験の隔離再実行は1件成功しました。接続障害の環境上の原因は未特定であり、123件すべて成功とは記録しません。[元のXML](main-reaudit-evidence/data-adjacent-123-diagnostic.xml)

- 独立cursor試験の初期fixtureは、決済cursorの検証前に行われる別途scope済みの支援枠SELECTまで禁止していました。修正版はそのSELECTを認め、不正cursor時に決済SELECTが0件であることを検証しています。[初期XML](main-reaudit-evidence/independent-boundaries-first-fixture-diagnostic.xml)

- runtimeの初期性能試験、古い期待値の修正、v1・v2・v3の不適切なrace fixtureは担当・独立報告で区別しています。最終的に実SQLでdeadlockへ到達したv4だけが、今回の追加修正を要求する再現証拠です。

## 画面で確認した範囲

rootによるローカルの画面確認では、実React、実サービスAPI、使い捨てMariaDBを接続し、変更履歴を50件、100件、102件まで読み込みました。版2・版1へ到達し、版1を復元して新しい下書き版103になることを確認しています。[操作結果](main-reaudit-evidence/browser-history-fdde-scenario.json)

![版1を復元した変更履歴画面。ローカルのテスト環境で、Discordは模擬。](main-reaudit-evidence/history-restored-desktop-fdde.jpg)

画面確認時のソースは中間版 `fdde3bd98bee5774eea0aac59466a5d7656a0c42` です。この証拠はUIの対象経路に限ります。旧f915では対象の6 UIコンポーネントが不変でした。新しいソースとの比較後に、このローカルUI経路の証拠を引き継ぐか判断します。追加runtime修正のブラウザー再試験や、本番での動作確認を示すものではありません。確認に使用したブラウザーと専用harnessは終了し、専用schemaも削除済みです。

## 新しい候補0769の変更と個別検証

候補 `07696234f4a8b57c123b7748b36366d7a7f1e3e2` は、旧f915から製品のロック方針を変更していません。`flow-history.js` の3関数を整形し、[AST比較](main-reaudit-evidence/source-0769-flow-history-format-ast-proof.json)で構文が同じであることと、parse診断0件を確認しています。

テスト側では、実際のownerロックが通知の物理送信と監視ルールの変更を直列化することを、双方が先に確定する場合で確認します。実SQLのdeadlockについては別の2行競合を使い、物理送信前にattemptがロールバックすること、送信0件から正規の再試行で1件だけ完了することを確認しています。[担当のv3試験XML](main-reaudit-evidence/source-0769-owner-order-v3-21.xml)は21件成功、失敗・skip・cancel・todo 0件です。

これらの個別結果とソースレビューは、全体試験の合格や配布物の承認とは区別します。変更対象は30の製品・テストパスとなり、同じ184試験ファイルの行列で試験を1件追加する予定ですが、最終件数は新しい実行結果から確定します。[canonical manifest](main-reaudit-evidence/canonical-source-0769-manifest.json)と[独立レビューv2](main-reaudit-evidence/independent-final-0769-owner-v2.json)、新しいroot実行ID 47219を記録しました。独立実行も[21件成功](main-reaudit-evidence/independent-final-0769-owner-21.xml)です。0769の全体試験は2,126件中6件失敗で不合格でした。後続ソースの最終件数と合否は未確定です。

展開手順の準備は、専用の `cbte-main-reaudit10-v8-source-rev2-20261016` で行います。旧f915の承認済み準備namespaceと証拠は保持し、新しい配布物の承認として流用しません。旧finalizerは引き続き実行しません。

独立レビューの初版は、AST serializerのcallbackが返した値で走査が早く終わっていました。v2はvoid callbackで全ASTを再計算しています。[初版報告](main-reaudit-evidence/independent-0769-first-ast-serializer-diagnostic.json)は診断用として保持し、承認にはv2だけを使います。rootの元のAST比較とSQL21件の結果に変更はありません。

## 外部CIの確認状況

正しい0769のGitHub実行 `1168974511843` は、Codacyがfailureのままです。2026年10月16日09:08 UTCの[公開ログ画面](main-reaudit-evidence/codacy-0769-plugin-crash.jpg)では、`codacy/codacy-eslint:9.18.12` の `security-node/detect-unhandled-async-errors` が、変更していない複数ファイルの解析中に `null.type` の例外で中断しています。rootとruntime担当が、公式情報を使って読み取り調査を続けています。

これは0769時点の履歴です。当時の旧f915の整形指摘とリモート先頭行の確認を、現在のd2の品質指摘3件の説明には使いません。ローカルの型検査・lint成功を、Codacy成功や全CI成功に置き換えません。ルールの無効化・除外や、固定ソースへの変更は行っていません。

## d2での追加修正と証拠

旧形式の親jobをfailed・unknownへ変更する後始末では、すべての対象の子jobも同じトランザクションで更新します。最初の候補は100件に制限し、子は主キー順の100件ページで最後まで処理します。mixed v1/v2の履歴、すでにsent・unknownになった子、ACK、別の将来予定は保持します。102子の2ページ目でEIOを発生させ、先行するgraph履歴も含めて全体が同じ状態へロールバックすることを確認しています。既存のlegacy SQLとowner-CASの期待値は変更していません。

UUIDの大文字・小文字がDBで同じ対象を指しても、内部のmutexキーやrun集合の照合が異なる問題も修正しました。正規化するのは内部キーと照合だけです。外部ID、保存済みUUIDの表記、namespaceKey、JSONの通信形式は保持します。[旧helperのRED](main-reaudit-evidence/independent-case-prior-helper-red-2.xml)と[新helperのGREEN](main-reaudit-evidence/independent-d2-case-green-2.xml)を区別して保存しています。

テスト用DB helperの変更は、SQLを送る前の接続取得だけに限定しています。条件に合うloopback TCP取得を最大3回、50ms・100msの待ち時間で試し、回復も安全な診断として記録します。SQL・work・commit・assertionを再実行しないことなど、socketを使わない19件で検証しています。Windows側の具体的な原因は、ERROR_SEM_TIMEOUT 121とWSAETIMEDOUT 10060のどちらかまで確定できていません。[因果境界の調査](main-reaudit-evidence/local-db-native-connect-causal-boundary.json)と[閉じた0769失敗の分類](main-reaudit-evidence/local-db-0769-closed-failure-classification.json)を保持し、接続取得の対策でOS原因まで直したとは扱いません。

- [担当の最終ソース62件](main-reaudit-evidence/runtime-author-d2-final-targeted-62.xml)は成功。[担当報告](main-reaudit-evidence/runtime-author-d2-cascade-case-report.json)に、修正と回帰の確認を記録しています。
- [独立レビュー](main-reaudit-evidence/independent-final-d2-cascade-case-admission.json)は全10 IDをCLEANとし、実SQL40件とsocketなしのhelper unit19件、合計59件が成功しています。[canonical manifest](main-reaudit-evidence/canonical-source-d2-manifest.json)の32ファイルとCORE8を照合しています。使い捨てschemaは残数0、既存の所有者不明7 schemaは操作していません。
- casefold前の別ソースの[150件](main-reaudit-evidence/runtime-prior-casefold-focused-150.xml)では、安全なTCP取得の再試行を1回記録しています。この結果を最終d2の全体成功へ置き換えません。

Codacyの中断原因は、公式配布ruleが合法なasyncのtry/finallyで存在しないcatch handlerのtypeを読んでしまう不具合と再現できました。[調査結果](main-reaudit-evidence/codacy-0769-vendor-rule-findings.json)と[ローカルの再現](main-reaudit-evidence/codacy-0769-local-vendor-recheck.json)を保存しています。取得したvendor ruleだけをローカルで修正した対照は導入しておらず、ruleの無効化や除外も行っていません。対照解析には3件の診断も残っており、Codacy成功や全CI成功とは記録しません。後続のexact d2の確認では、新しい品質指摘3件と同じvendor中断をそれぞれ確認しています。0769だけの履歴ではなく、d2の現在の課題として下記へ追記します。

## d2のソース証明とローカル展開準備

[rootのソース証明](main-reaudit-evidence/root-reviewed-d2-source-attestation.json)と[レビュー済みcanonical manifest](main-reaudit-evidence/root-reviewed-d2-canonical-manifest.json)を保存しました。rev3の[固定記録](main-reaudit-evidence/ops-rev3-d2-approved-local-freeze.json)、[ソース契約](main-reaudit-evidence/ops-rev3-d2-local-source-contract.json)、[独立したローカル202件のレビュー](main-reaudit-evidence/independent-ops-rev3-d2-local-202-review.json)も保存しています。

これらはローカルのソース・展開手順準備の確認です。実mainから作った配布物の承認、SSH、本番操作、185ファイルの製品全体試験の合格を示すものではありません。main・実bundle・本番SHAはnull、実OAuth・新しいX投稿からDiscordへの配信・実Square決済の確認はfalseのままです。Codacyのvendor不具合も、クラウド成功へ置き換えていません。

## exact d2の品質指摘と最終ソースの方針

[exact d2のCI実行116911852085](main-reaudit-evidence/current-d2-ci-check-116911852085.json)はaction_requiredで、`flow-history.js` の15行目にJSDoc不足、16行目にindent、17行目にPrettierの新しい品質指摘があります。これら3件は実際の残課題です。旧指摘の残存だけで説明した見方を訂正し、「コード品質もすべて修正済み」とは扱いません。

同時に、rootは10:09 UTCの[現在のd2ログ画面](main-reaudit-evidence/current-d2-codacy-plugin-crash.jpg)で、同じvendor9.18.12のnull handler例外が変更していない5ファイルに発生することも確認しました。vendor不具合と新しい品質指摘は別々に記録し、片方で他方を説明しません。

担当はTempに、ファイル全体のPrettierと11個のJSDocを含む案を準備しています。固定d2の全体試験中にCOREへ適用していません。TypeScript・Espreeの全AST、SQL・文字列、exportsの等価性、品質lintと、ソース文字列に依存する試験への影響を確認します。修正後のソースで全体試験を再実行するか、d2の全体試験と厳密な等価証拠を引き継ぐかは、まだ決めていません。

10:10 UTC時点のrootの進行確認では、以前の実際の失敗4経路はすべて成功し、安全な接続取得の再試行を1回記録しています。これは途中経過であり、最終件数や全体合格には置き換えません。文書作成側は進行中XMLを読んでいません。

## rootが決めたD2実行結果と最終Fの関係

全体を実行したソースは `d2e792d30a44723e603869b27970b05597d51a9d`、最終コード候補は `e88e74412905987352af0ae7cec665963fc737d0` と別に記録します。Fとの差分は `flow-history.js` の整形・JSDocだけで、正確なファイルSHAは `aa1580814a0289b029a17a1805485391026a0b68ed8418a6250e1c637b95f6f4` です。

[独立した等価確認](main-reaudit-evidence/independent-nullable-style-equivalence-assessment.json)は、TypeScriptとEspreeの全実行AST、SQL・template・regex・文字列、exports、ソース表記への依存を確認しています。他31のレビュー対象、残りのCORE、185試験ファイルと依存ファイルも同じであることを根拠にします。[型の等価確認](main-reaudit-evidence/flow-style-effective-type-equivalence.json)では同じprogram内の11関数を両方向に検査し、通常診断は0件のまま、strictNullChecksの既存527件も増えていません。`string|null`の説明を実際より狭めて表示だけを一致させたものではありません。

rootは適用済みFのroot/dashboard型検査、lint、node構文検査、差分検査の成功を確認しています。独立したFのflow22件も成功との報告ですが、正確な証明書とcleanup記録の確定を待っています。Fの全10件のcanonical証明と、専用REV4のローカル202件承認がそろうまで、最終化は行いません。実行した全体試験をFとして報告することもありません。

D2で実際に見つかったJSDoc・indent・Prettierの3件は、Fのローカル対策と確認へ進みました。vendorの例外は別の問題であり、FのクラウドCI結果は未確定です。PR説明も「クラウドCIも成功」とは扱わない方針に更新します。

## 最終判定までに必要な確認

<!-- FINAL_LOCAL_GATE_BEGIN -->
- D2の全体2151件成功と最終Fを分け、exact Fのcanonical32ファイル・CORE8・schema69、等価証拠、実F22件、適用後の型/lint証拠を照合する。
- REV4のF専用ローカル202件承認を待つ。前のREV3/D2準備はFや実bundleの承認へ流用しない。
- これらの証拠に固定した新しい二つのソースを識別するfinalizerを準備し、独立確認後にrootが実行する。main・実bundle・本番は別の確認として残す。
<!-- FINAL_LOCAL_GATE_END -->

- 最終ソースと画面確認済みのUI・APIの内容を比較し、対象経路が変わった場合は画面を再確認する。

- mainへの統合後のSHAと、検証した製品ソースの対応を確認する。

- V8の実配布物と展開手順を最終ソースに対して審査し、支援者限定の本番反映後にresidentのSHA、全シャード、lease、heartbeat、アプリの初期化、既存X受信の接続を確認する。

- 既存データ、通知・課金設定、通常の30分設定と個別の5分設定を維持し、復旧手順の検証結果を残す。

V8は手順の準備段階です。今回の10件を修正したソースの本番反映は、まだ行っていません。rootの2026年10月16日07:56 UTCの読み取り確認では、本番は既存の `c63003f5dbd585a3f09e8672a0f80fa5db460165`、支援者限定、全14シャードreadyでした。この文書作成で本番データや稼働サービスへの変更は行っていません。

実OAuth、新しい実X投稿からDiscordへの配信、実Square決済は未検証です。fixtureやローカル画面の証拠とは区別して記録します。

