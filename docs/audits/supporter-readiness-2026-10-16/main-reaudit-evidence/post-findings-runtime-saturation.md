# integrated main 第2回 runtime/provider 飽和監査

対象は `origin/main` と一致する HEAD `2a000c89a293e2ee71ef0c579a63def2ff12cbdb`。既知53件と `MAIN-UI-1`、`MAIN-FRESH-1`〜`MAIN-FRESH-3` は重複計上から除外した。結果は **新規P1 0件、新規P2 1件**。製品コード、本番、外部サービスは変更していない。

## MAIN-FRESH-4 — P2 — 複数送信へ分岐したrunの概要が、一部失敗でも「送信済み」になり得る

開始ノードから2つの独立した送信ノードへ分岐するルールは正式にvalidationを通る。実SQL・実graph runtimeで1イベントを処理すると、同じrunに属する2件のdelivery jobが作られた。通常runnerで1件目を送信成功、2件目をDiscordの確定403相当で失敗させた結果は次のとおり。

- job A: `sent`、`sent_steps=1`
- job B: `failed / DESTINATION_OR_POLICY_DENIED`、`sent_steps=0`
- 実際のrun概要: **`sent`**

送信済みjobと失敗jobの状態を同じ2行の間で入れ替えて履歴を再投影すると、run概要も `sent` と `failed` の間で入れ替わった。配信内容や成功件数は同じであり、違うのはどちらのjob行へ状態を置いたかだけである。

原因は `src/automation/flow-history.js:68`。すべて送信済みなら `sent`、未完了jobがあれば `queued` とした後、それ以外の複数terminal状態を `jobs[0].state` で決めている。job取得SQLに順序指定もなく、複数jobの結果を合成していない。

少なくとも、1件以上の送信確認と1件以上の未送信terminal結果が混在するrunは、完全な `sent` と表示してはいけない。既存state語彙の `partial` を使うか、同等の決定的な集約規則が必要である。送信確認が1件もない場合も、失敗・期限切れ・取消などの優先順位を明示して行順に依存させない必要がある。

利用者はルールの処理履歴を見て全分岐が配信済みだと誤認し、失敗した宛先・分岐の調査を逃す。個別jobはDBと配信履歴に残るためデータ消失ではないが、同じ実行の主要な結果表示が事実と反するためP2とした。

証拠: [post-findings-flow-multijob-probe.cjs](post-findings-flow-multijob-probe.cjs)。使い捨てschemaは終了時に削除した。

## 棄却した候補と対照

- cadence枠をprepare前、prepare後、quota予約後に1枠から2枠へ変更する4つの実SQL・runner対照は、すべて1回だけ送信し、jobを `sent`、日次使用を1通、予約残を0にした。追加のcadence枠は取得間隔用であり、物理送信quotaのprincipalを変えないため `AUTOMATION_SLOT_CHANGED` の通知欠落候補は成立しなかった。[probe](post-findings-runtime-probe.cjs)
- 最大5,000件のdurable backlog cursorについて、`deferredItems` 全体のbyte検査はitemごとではなく配列検証の後に1回だけ行われることを計測した。50・100・200・400件の実測もこの疑いを支持せず、二乗CPU候補は棄却した。[probe](post-findings-backlog-parse-probe.cjs)
- sending lease期限切れ、予約後のprocess終了、分割途中の権限取消、plan変更、quota返却、source backlogのrestart/lease喪失、復旧cutoff、Xの複数ページ・retry cursorは重点試験で正常だった。
- 複数ページのcadence UI、workflow履歴、X保存raceは既報 `MAIN-FRESH-1`〜`3` として除外した。

## 検証

次の3群を同じHEADで実行し、**118件成功、失敗0、skip 0**。

- quota・部分送信・権限・cadence lifecycle: 61件
- provider backlog・価格状態・source cursor: 14件
- 復旧cutoff・flow投影・X runtime/retry: 43件

対象には `automation-rate-limits-sql`、`automation-delivery-gate`、`automation-saturation-boundary-sql`、`automation-monitor-cadence-lifecycle-sql`、`provider-saturation-backlog-sql`、`provider-saturation-sql`、`autoWatch.admission-sql`、`priceWatch.runner`、`automation-recovery-cutoff-sql`、flow route/projector、X push runtime/retryを含む。

実Discord、実X Push、実プロバイダー、本番DB、デプロイは未検証。Discord応答、時刻、失敗、権限はローカルfixtureである。機械可読結果は [post-findings-runtime-saturation.json](post-findings-runtime-saturation.json)。
