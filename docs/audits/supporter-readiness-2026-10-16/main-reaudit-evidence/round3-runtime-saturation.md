# integrated main 第3回 runtime clean-saturation監査

対象は `origin/main` と一致する HEAD `2a000c89a293e2ee71ef0c579a63def2ff12cbdb`。既知53件と、現時点の9件 `MAIN-UI-1`、`MAIN-FRESH-1`〜`4`、`MAIN-DATA-1`〜`2`、`MAIN-POST-1`〜`2` を除外した。

結果は **新規P1 0件、新規P2 1件**。このroundは0件のclean waveにはならなかった。追加候補は残していない。

## MAIN-FRESH-5 — P2 — queue外のjob状態変更がflow run履歴へ反映されない

単一sendノードの有効なflow-v2を、実SQL・実graph runtime・実queueで3通り確認した。

### sending leaseの期限切れ

jobを `sending` にした直後のprocess停止相当としてleaseを期限切れにし、新しいqueue instanceで回収した。

- jobは安全側に `unknown / SEND_LEASE_EXPIRED` へ移行した。
- 同じrunの概要は **`queued` のまま**残った。
- 通常の `queue.transition(job, "unknown")` 対照では、jobとrunの両方が `unknown` になった。

さらに、1通目のACKを `sent_steps=1` とDiscord message IDへ保存した後にleaseを期限切れにしても、jobは `unknown`、runは `queued` になった。jobの `unknown` は、process停止時点で次の送信がwireへ入ったか判別できない場合に不確実性を優先する既存方針であり、新しい欠陥とは判定しない。この対照でも、runだけが `queued` のまま残る投影欠落は同じである。

### 利用者による取消

Dashboardと同じ `history.change(..., action: "cancel")` で、未送信のprojected flow jobを取り消した。

- jobは正しく `cancelled / USER_CANCEL` になった。
- run概要は **`queued` のまま**残った。
- 同じtransaction後に `refreshFlowHistory` を明示的に実行する対照では、runは `cancelled` になった。

取消は通常の利用者操作であり、再起動事故だけの問題ではない。job詳細とルール処理履歴が永続的に矛盾し、取消理由がrun履歴の対象状態にも現れない。

### 原因

- `src/automation/queue.js:329-331` は、期限切れの `sending` と旧 `held` job、集約子jobを直接更新するが、影響したflow-v2 runを再投影しない。
- `src/automation/history.js:145-148` は、取消・再予約・再試行を直接更新するが、flow-v2 runを再投影しない。
- 通常の `queue.transition` は `src/automation/queue.js:515` で `refreshFlowHistory` を同じtransaction内から呼ぶため、対照だけが正しい。

`MAIN-FRESH-4` は複数jobのterminal stateを行順で集約する問題だった。今回はjobが1件でも発生し、正しいjob状態がrunへ投影されない別根因である。

修正では、job状態をqueue以外から変更する全経路で、影響するexecution-v2 run IDを同じtransaction内で収集し、履歴を再投影するか、確実に処理される同期印を付ける必要がある。大量回収はbounded batchにする。sending leaseの既存 `unknown` 方針を維持したまま、runも同じ状態へ進める。取消・retry・reschedule、旧hold、破損planの終端化、restartをまとめて回帰試験する。

証拠: [round3-runtime-restart-history-probe.cjs](round3-runtime-restart-history-probe.cjs)。使い捨てschemaは終了時に削除した。

## 最終範囲

`MAIN-FRESH-4` の unknown・partial・cancelled・expired 組合せは同じunordered aggregation根因として再計上しなかった。workflow削除はflow runへrevocationと`needs_sync`を付ける既存経路を持つ。破損planのclaim時終端化にも同じ投影欠落があるが、通常producerから作れないため別件にはしていない。

関連するruntime、SQL履歴、monitor activity、flow traceの5試験ファイルは **42件成功、失敗0、skip 0**。既存のsending lease試験はjobがunknownになることだけを確認し、run概要を確認していなかった。

製品ソース、本番DB、実Discord、実X Push、実プロバイダー、デプロイは変更・操作していない。機械可読結果は [round3-runtime-saturation.json](round3-runtime-saturation.json)。
