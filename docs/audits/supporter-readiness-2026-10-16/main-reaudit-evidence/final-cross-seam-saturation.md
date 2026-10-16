# integrated main final cross-seam saturation

- 対象HEAD: `2a000c89a293e2ee71ef0c579a63def2ff12cbdb`
- 結果: **追加P1 0件、追加P2 0件**
- 製品コード変更: なし
- 実Discord・X・Square、本番DB、OAuth、配備操作: なし

## 判定範囲

既知53件と、main再監査で確定済みの次の10件は新規指摘として数えていない。

1. `MAIN-UI-1`
2. `MAIN-UI-2 / MAIN-FRESH-1`
3. `MAIN-FRESH-2`
4. `MAIN-FRESH-3`
5. `MAIN-DATA-1`
6. `MAIN-DATA-2`
7. `MAIN-POST-1`
8. `MAIN-POST-2`
9. `MAIN-RUNTIME-MIXED`
10. `MAIN-FRESH-5`

この最終回では、過去のUI中心の監査とは異なるソースを優先し、admin write、Marketplace moderation、package/dictionary provenance、flow trace、recovery origin、graph joinの接続部を静的に追った。P1/P2になり得る経路だけを残し、既知指摘の別症状とP2未満の使い勝手は候補から除外した。

## 横断確認

### admin writeとmoderation

moderation policyの更新は、admin actorの再確認、辞書IDと固定revisionの実在確認、policy行の`FOR UPDATE`、expected revisionのCAS、policy更新とaudit追加を同一transactionで行う。publication screeningは保存済みの辞書ID/revisionを使い、matcher cacheもその組で分離される。adminによるpolicy更新と並行公開、辞書改訂、権限喪失をまたいで、別revisionや別主体へ審査が移る経路は確認しなかった。

通報解決後のaudit失敗で状態だけ確定する問題は`MAIN-DATA-2`、通報対象がimmutable package versionへ固定されない問題は`MAIN-POST-2`として除外した。open reportが古い順100件を返す境界は、1件解決すると101件目が同じ入口へ出るFIFOであり、到達不能な行を再現しないためP2未満のままとした。

### Marketplace、install、provenance

install/import-for-editing/updateはpackage行をlockし、server側から取得したpackage ID、version、checksumを使う。update preview tokenには導入元版、対象版、checksum、workflow revision、dictionary revisionとbindingが含まれ、commit時に再計算される。dictionaryとworkflowのoriginはeditable bundleではなくlock済みpackageから記録され、依存packageもversion/checksumまで照合される。

実行時のsafety checkはworkflowの固定revisionからdictionary bindingを復元し、package、edition、推移依存のrevocationとchecksum不一致をfail closedにする。install一覧はowner/guild scopeを維持し、50件単位のcursorで後続を取得する。版、owner、scope、cursorを混同する別のP1/P2は確認しなかった。

### flow historyとpagination

完全traceはrun IDとsnapshot revisionをcursorへ含め、source manifestまたは本文hashが途中で変われば409にする。step、batch、merge、send、job、revoked originを複数ページへ分割し、大きな単一diagnosticを切り捨てない。run取得側のowner/guild authorizationと組み合わせ、別runのcursor再利用や変更途中の混在を許さない。

複数send jobの集約順でhistory stateが変わる問題は`MAIN-RUNTIME-MIXED`、flow-v2 jobをqueue transition外で変更した際にrun projectionが残る問題は`MAIN-FRESH-5`、workflow history自体の100件上限は`MAIN-FRESH-2`として除外した。Marketplace revoke、workflow delete、housekeepingがjobを直接終端化する箇所は`MAIN-FRESH-5`と同じprojection更新漏れであり、別件に分割していない。

### recovery、restart、graph lifecycle

recovery originは復元時cutoffより古いrun/inboxを送信前に判定し、旧runをrevokedかつ`needs_sync`へ進める。graph storeとjoin storeはその判定をunit生成・merge決定より先に適用し、revoked memberをexcluded receiptとして固定する。復元状態、managed directory、SQL paging checkpoint、起動時workload gate、再起動後の完了receiptを含む実経路試験でも旧データの再配信は生じなかった。

corrupt plan、expired lease、held cleanup、retry、cancelに伴うrun stateのずれは`MAIN-FRESH-5`の同一根として扱った。recovery cutoff、namespace/run identity、join member、restart checkpointに別のP1/P2は確認しなかった。

### destination、quota、accounting

webhook destination作成は利用者とBot双方のManage Webhooksを要求する。service policyは永続operation counterを複数service instanceで共有し、nested operationの二重課金を避け、quota枯渇後もpause/delete/historyを許可する。monitor slotはauto/priceを合算し、再作成による上限回避を防ぐ。

auto/priceのnumeric ID衝突による削除対象誤認は`MAIN-UI-1`、cadence 2ページ目の保存後再取得失敗は`MAIN-UI-2 / MAIN-FRESH-1`、Xの無関係refreshが確定保存応答を捨てる問題は`MAIN-FRESH-3`、Square支払い履歴のmerchant/environment混在は`MAIN-DATA-1`として除外した。隣接する作成、権限、quota、owner identityに別のP1/P2は確認しなかった。

## 検証

次の12ファイルを直列実行し、**118件成功、失敗0、skip 0**だった。

- `automation-moderation.test.js`
- `automation-safety.test.js`
- `automation-publication-sql.test.js`
- `automation-marketplace-provenance-sql.test.js`
- `automation-package-lineage-sql.test.js`
- `automation-dictionary-publication-sql.test.js`
- `automation-recovery-cutoff-sql.test.js`
- `automation-recovery-managed-data.test.js`
- `recovery-bootstrap.test.js`
- `automation-service-policy-sql.test.js`
- `webhook-destination.test.js`
- `automation-push-support-grants-sql.test.js`

実SQL試験はテストhelperが作るランダムな使い捨てschemaだけを使用し、各`finally`で削除した。ログは`final-cross-seam-tests.log`に保存した。終了時のproduct worktreeはcleanで、HEADは上記SHAのままである。

指定されたUI/API/runtime/data横断の最終回では、既知53件と確定済み10件を除く、独立した追加P1/P2は0件だった。
