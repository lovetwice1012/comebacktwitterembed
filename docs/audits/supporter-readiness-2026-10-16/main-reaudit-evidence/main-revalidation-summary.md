# main 統合後の再監査まとめ

- 対象: `origin/main` / `2a000c89a293e2ee71ef0c579a63def2ff12cbdb`
- 対象commit: `Merge pull request #50 from lovetwice1012/codex/saturation-audit-fixes-20261016`
- 最終確認: 2026-10-16 JST
- 製品コード変更: なし

## 判定

統合前の監査で管理していた53件（P1 12件、P2 41件）は、統合後のmainで **53件すべて修正済み**だった。UI、runtime/provider/recovery、data/API/X/billingの独立結果を集合化すると53個のIDがremediation mapと一致し、未確認IDは0件だった。

一方、統合後の実装を既知指摘から独立して再監査した結果、**新規P1は0件、新規P2は10件**残っている。したがって、このSHAを「P2なし」とは判定しない。

10件を除外した後の最終監査周はすべて追加0件だった。

- UI/data clean round: 143/143成功
- runtime clean round: 63/63成功
- backend/API clean round: 186/186成功
- cross-lane clean round: 151/151成功
- independent all-seam clean round: 118/118成功

## 新規P2

| ID | 問題 | 実害 | 主な箇所 |
|---|---|---|---|
| MAIN-UI-1 | 新着通知と価格通知の数値ID衝突 | `auto:7`の未保存下書きを保持中に`price:7`を削除すると、別種類の下書きまで確認なしで消える | `dashboard/components/automation/monitor-manager.tsx:225-230` |
| MAIN-UI-2 (`MAIN-FRESH-1`) | 2ページ目の確認間隔保存後に対象を再取得できない | 101件目以降の変更はcommit済みなのに旧revision・旧間隔を表示し、再取得も失敗、次回保存は古いCASで409になる | `monitor-manager.tsx:239-254`, `monitor-cadence-editor.tsx:41-45` |
| MAIN-FRESH-2 | ルール変更履歴が最新100版で切れる | 版1・2はDBに残り直接復元可能でも、102版作成後は通常画面から表示・復元できない | `src/automation/service.js:334-337`, `automation-workspace.tsx:336,345-351` |
| MAIN-FRESH-3 | 無関係なX受信情報更新が確定済み監視PATCHを破棄する | サーバーは保存済みでもUIは旧revisionを保持し、再保存が409になる。作成、編集、停止、再開に影響 | `x-monitor-manager.tsx:62-90,116-120,173-196` |
| MAIN-DATA-1 | Push枠の決済履歴がSquare scopeをまたいで混ざる | 現在のsandbox/merchant履歴に別環境・別merchantの決済が同じ表示で混在し、手動枠付与の判断を誤らせる | `src/automation/api.js:72-82` |
| MAIN-DATA-2 | 通報解決と監査記録が同一transactionでない | 監査INSERT失敗時も通報だけ`resolved`になり、APIは失敗、監査は0件、再試行は404になる | `src/automation/marketplace-core.js:388-392` |
| MAIN-POST-1 | 保存前の親一覧readが管理設定のcanonical CAS版を巻き戻す | クーポン・通知プランの保存成功後に古いGETが到着するとbaselineが旧版へ戻り、次の保存が古いCASで競合する | `square-commerce-manager.tsx:90-117`, `notification-plan-manager.tsx:64-75,207-220` |
| MAIN-POST-2 | Marketplace通報がimmutableな対象版へ固定されない | v1通報後に作者がv2を公開するとmoderatorはv2を開く。通報対象v1は公開・取得・導入可能なまま残る | `marketplace-core.js:368-380`, `marketplace-manager.tsx:161,182` |
| MAIN-FRESH-4 (`MAIN-RUNTIME-MIXED`) | 分岐配信のrun状態がunordered jobの先頭行で決まる | 1枝送信済み・1枝失敗でもrunを`sent`と表示でき、job IDへの状態割当を交換すると`sent`/`failed`が反転する | `src/automation/flow-history.js:43,66-70` |
| MAIN-FRESH-5 | queue外のjob状態変更がflow runへ再投影されない | lease期限切れでjob=`unknown`、取消でjob=`cancelled`、retryでjob=`pending`になってもrunは旧`queued`/`failed`のまま残る | `src/automation/queue.js:325-331`, `src/automation/history.js:121-150` |

## 修正順

1. `MAIN-DATA-1` と `MAIN-POST-2`: 金銭判断とmoderation対象を誤らせる境界を先に閉じる。
2. `MAIN-DATA-2`: 状態変更と監査を同じtransactionへ入れる。
3. `MAIN-FRESH-4` と `MAIN-FRESH-5`: job/run履歴を決定的かつ同一transactionで同期する。
4. `MAIN-POST-1` と `MAIN-FRESH-3`: 確定済みwrite応答を古いread世代から保護する。
5. `MAIN-UI-2`、`MAIN-FRESH-2`、`MAIN-UI-1`: paginationと種類付きIDを修正し、保存後回復・履歴到達・下書き保持を保証する。

## 修正後の受入条件

- 通知下書きは必ず`(kind,id)`で照合する。
- 2ページ目以降の通知とルール版を、循環cursorを拒否しつつ最後まで取得できる。
- mutationのcanonical応答は、保存前に開始したreadや無関係なresource refreshで上書き・破棄されない。
- Push枠の決済履歴は現在のSquare `environment + merchant_id`で絞り、scopeをcursorと表示契約へ含める。
- 通報は表示中のpackage version/checksumへ固定し、解決stateと監査行を同じtransactionで確定する。
- 複数jobのrun stateは順序非依存で集約し、送信確認とterminal失敗の混在を完全な`sent`にしない。
- cancel/retry/lease回収など、jobを直接変更する全経路が同じtransaction内でflow runを再投影する。

## 検証

mainの統合受入スイート176ファイルは2066テストを実行し、2065成功、1件はassertion前のMariaDB接続`ETIMEDOUT`だった。該当ファイル全体を隔離再実行して8/8成功したため、製品失敗には数えていない。

- root ESLint: 成功
- dashboard ESLint: 成功
- dashboard TypeScript: 成功
- root TypeScript: isolated worktreeにgitignore対象`config.json`がない初回だけmodule resolutionで失敗。空の一時configを置いた再実行は成功し、そのファイルは削除済み
- 新規10件: 実React、実service/API、使い捨てMariaDB、実queue/graph/runnerで再現し、主要候補は別harnessでも再現
- `origin/main`と監査HEAD: 一致
- tracked worktree: clean
- この監査で作成したMariaDB schema: 全削除。開始前から残っていた7 schemaは所有権不明のため保持

通報一覧の100件上限は、古い順に処理すると101件目が同じ入口へ現れるFIFO対照を確認したためP2には数えなかった。

## 証拠

- 既知53件: [ui-report.md](ui-report.md), [runtime-report.md](runtime-report.md), [data-report.md](data-report.md)
- 最初の新規4件: [fresh-saturation-report.md](fresh-saturation-report.md), [ui-id-collision-independent.md](ui-id-collision-independent.md)
- data/API: [post-findings-data-api-saturation.md](post-findings-data-api-saturation.md), [independent-data-findings.md](independent-data-findings.md)
- admin/Marketplace: [post-findings-ui-data-saturation.md](post-findings-ui-data-saturation.md), [independent-latest-ui-data.md](independent-latest-ui-data.md)
- flow履歴: [post-findings-runtime-saturation.md](post-findings-runtime-saturation.md), [round3-runtime-saturation.md](round3-runtime-saturation.md)
- 最終0件周: [round3-ui-data-saturation.md](round3-ui-data-saturation.md), [round4-runtime-saturation.md](round4-runtime-saturation.md), [round4-cross-lane-saturation.md](round4-cross-lane-saturation.md), [final-cross-seam-saturation.md](final-cross-seam-saturation.md)
- 全体受入JUnit: [supporter-readiness-main-tests.xml](supporter-readiness-main-tests.xml)

## 未検証境界

実Discord配信、新しい実X投稿の受信、OAuth、実Square決済、本番DB書込、再デプロイは今回行っていない。検証はmainのローカル統合ソース、fixture、mock transport/provider、使い捨てMariaDBに対するもの。
