# integrated main 新規 P1/P2 飽和監査

- 対象: `2a000c89a293e2ee71ef0c579a63def2ff12cbdb`
- 実施日: 2026-10-16 JST
- 結果: **追加 P1 は0件、追加 P2 は3件**
- 既知の `MAIN-UI-1`（新着通知と価格通知の数値ID衝突で別種類の保持中下書きを消す）は重複計上していない。
- 製品コードは変更していない。対象worktreeは監査終了時もcleanで、HEADは上記SHAのままである。

## MAIN-FRESH-1 — P2 — 101件目以降の通知で確認間隔を保存すると、保存後の画面が古い版から回復できない

`dashboard/components/automation/monitor-manager.tsx:239-254` の `reloadCadence()` は `monitors/auto` の先頭ページだけを取得し、結果で現在の一覧を置き換える。2ページ目以降から開いた通知は見つからず `null` になる。通常の競合回復で使う `reloadMonitorDraft()` は全ページをたどるが、確認間隔の経路はこれを使わない。

`dashboard/components/automation/monitor-cadence-editor.tsx:44` の保存経路は `await onReload()` の `null` を検査せず、サーバーの変更が確定したという成功表示を出す。表示中の行・編集baselineは以前の `revision`、`slotCost`、`cadenceUpdatedAtMs`、確認間隔のままになる。明示的な「通知・利用枠を再取得」も同じ先頭ページ限定関数を使い、対象を取得できない。再保存は古いCASで衝突する。

実React probeでは101件目の通知を1枠・30分から2枠・15分へ変更した。書込みは1回成功し、画面は「15分で保存」と表示した一方、現在値は30分のままだった。保存後の取得は先頭100件だけで、2ページ目のcursorを再度たどらず、明示的再取得も失敗した。

修正案: ID指定のowner-scoped readを追加するか、`reloadCadence()` も循環cursorを拒否しつつ対象が見つかるまで全ページを読む。保存応答へ新しいmonitor revisionとcadence snapshotを含めて直接baselineを進め、再取得が `null` の場合は成功表示だけを出さない。

## MAIN-FRESH-2 — P2 — ルールの変更履歴が最新100版で無言に切れ、古い保存版を画面から復元できない

`src/automation/service.js:334-337` の `history()` は `ORDER BY revision DESC LIMIT 100` の配列だけを返し、cursorや「続きあり」を返さない。`dashboard/components/automation/automation-workspace.tsx:336,345-351` もこの配列を全履歴として描画し、古い版を読む操作を持たない。

実MariaDBの使い捨てschemaで102版を保存した状態を作ると、APIは版102〜3の100件だけを返し、版1と2を表示しなかった。版1はDBに残っており、番号を直接指定した `restoreRevision(..., 1, 102)` は成功して版103になった。つまり保持期間や削除ではなく、履歴・復元UIだけが黙って到達不能にしている。

修正案: `beforeRevision` による安定したkeyset paginationをAPIへ追加し、`items` と `nextRevision` を返す。画面に「古い版を読み込む」を追加し、選択中のルールID・現在revisionへ応答を結び付ける。

## MAIN-FRESH-3 — P2 — 無関係なX受信情報の更新が、確定済みX監視保存の応答を破棄する

`dashboard/components/automation/x-monitor-manager.tsx:116-120` は監視の書込みと一覧読込で同じ `epoch` を使う。受信情報が変わると、`subscriptionsVersion` に依存するeffect（同:90）が `load()` を起動し、epochを進める。監視PATCHがその後に成功しても、同:185 のepoch比較がcanonicalな保存応答を破棄し、同:186の編集baseline更新・dialog終了・成功表示へ進まない。

実React probeでは、未使用のX受信情報を別の受信情報パネルから削除して一覧更新を発生させながら、X監視名のPATCHを完了させた。サーバー側は名前とrevision 2を保存したが、画面はrevision 1の下書きを開いたままで成功を表示せず、次の保存は再び `expectedRevision: 1` を送って競合した。受信情報の削除対象はその監視に未割当であり、監視revisionを変える操作ではない。

修正案: read generationとmutation identityを分離する。認証主体・API・編集対象IDが同じである限り、確定した書込み応答は無関係なread epochで捨てず、canonical responseでbaselineを進める。その後に最新一覧を読むか、書込み中の背景loadを待たせる。遅いreadが保存応答を上書きしない世代検査も維持する。

## 検証

次の既存試験と独立probeを同じmain worktreeで直列実行した。

- `scripts/test/automation-monitor-editor-ui.test.js`
- `scripts/test/automation-workflow-history-sql.test.js`
- `scripts/test/automation-x-monitor-ui.test.js`
- `fresh-saturation-cadence-probe.test.cjs`
- `fresh-saturation-workflow-history-probe.test.cjs`
- `fresh-saturation-x-save-race-probe.test.cjs`

結果は **86件成功、失敗0、skip 0**。MariaDB probeが作成した `cbte_automation_test_<random>` schemaは各試験の `finally` で完全削除した。ログは `fresh-saturation-focused-tests.log` に保存した。

監査では既知53件の対応表を再利用して新規指摘を水増しせず、種類付きID、owner/guild、provider/resource、cursor、CAS、保存後再取得、復旧由来、枠予約・精算、API/UI契約の継ぎ目を静的に追跡した。上記3件を確定した後に同じ優先面をもう1周確認し、これ以外の新しいP1/P2は確定しなかった。実Discord、実X通知、実Square、OAuth、本番DB、本番配備はこの独立passでは操作していない。

