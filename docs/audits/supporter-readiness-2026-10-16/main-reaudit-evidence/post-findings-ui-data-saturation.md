# integrated main post-findings UI/data saturation

- 対象HEAD: `2a000c89a293e2ee71ef0c579a63def2ff12cbdb`
- 監査結果: **追加P1 0件、追加P2 2件**
- 除外済み: 既知53件、`MAIN-UI-1`、`MAIN-UI-2 / MAIN-FRESH-1`、`MAIN-FRESH-2`、`MAIN-FRESH-3`
- 製品コード変更: なし
- 外部サービス・本番操作: なし

## MAIN-POST-1 — P2 — 保存前に開始した管理一覧の応答が、確定済みクーポン・通知プランのCAS版を巻き戻す

管理一覧のread世代と子editorのwrite結果が連携していない。

- クーポン: `dashboard/components/admin/square-commerce-manager.tsx:93-94` は保存応答をdraftと親一覧へ反映するが、親の `load()`（同:116）と `saved()`（同:117）は同じ世代を共有しない。
- 通知プラン: `dashboard/components/admin/notification-plan-manager.tsx:73-75` は保存応答を反映するが、親の `load()`（同:207-211）と `saved()`（同:220）は同じ `request` fenceを共有しない。
- 親の「一覧を更新」は子editorの保存中にも押せる。保存前のsnapshotを取得したreadが保存応答より後に完了すると、親propsだけを古いCAS版へ戻す。

実Reactで両経路を別々に再現した。

1. version 100の設定を編集し、PATCH応答を保留した。
2. 親の一覧更新を開始し、version 100の応答を保留した。
3. PATCHをversion 101として確定し、画面が成功表示とcanonical値を受け取った。
4. 古い一覧応答を返した。
5. 入力欄は保存値を保持する一方、親から渡るbaselineだけがversion 100へ戻った。
6. 次の保存は再び `expectedUpdatedAtMs: 100` を送信し、実際のversion 101に対して競合した。

クーポン・通知プランとも送信されたCASは `[100, 100]` だった。既存項目では保存成功後の操作が競合し、新規作成では遅い一覧が作成済み項目を画面から消して、同じ作成を再試行させ得る。DBの確定値は壊れないが、管理者が保存済み変更を継続管理できず、成功表示と操作対象の版が矛盾する。

修正案: 子writeが確定した時点で親のread generationを進める。さらに一覧全置換時は、同じID/codeの既知の新しい `updatedAtMs` より古い行を採用しない。親refreshを子write中に無効化するだけでなく、遅延応答を防ぐ世代・単調版比較を入れる。

## MAIN-POST-2 — P2 — パッケージ通報が表示版へ固定されず、作者の新版公開後に管理者が別内容を確認する

通報保存は `src/automation/marketplace-core.js:368-380` で `subject_id` と理由だけを記録し、版・checksumを保持しない。UIも `dashboard/components/automation/marketplace-manager.tsx:161` から理由だけを送る。管理画面は同:182で `open(r.subject_id, undefined, "")` を呼ぶため、その時点の最新版を開く。

実サービスと使い捨てMariaDBで次を確認した。

1. 利用者が公開版v1を表示して通報した。
2. 作者が同じpackage IDへ別内容の公開版v2を保存した。
3. review queueの通報には理由しかなく、v1の版番号・checksumはなかった。
4. 管理者の既定取得はv2を返した。
5. 通報対象だったv1は引き続き `active` で、一般利用者が版1を指定すると取得できた。

実Reactでも、通報の「共有内容を確認」が版未指定でopen APIを呼び、置換後のv2を表示した。管理者は通報されたimmutable editionを識別できず、内容を差し替えた作者が通報確認を別内容へ向けられる。旧版は公開・導入可能なままなので、単なる表示上の履歴不足ではない。

修正案: 通報時に、画面が表示している版をクライアントから送り、サーバーでそのpackage・公開可視性・checksumと照合してimmutableな `version` と `checksum` を保存する。review APIで返し、管理画面は必ずその版を開く。版が後から非公開・撤回された場合も、権限を持つmoderatorが保存済み通報snapshotを確認できる経路を用意する。

## P2に数えなかった候補

`reviewQueue()` はopen通報を古い順に100件返し、cursorを持たない。101件の実SQL対照では、先頭1件を通常どおり対応済みにすると101件目が同じ画面へ現れた。FIFOの処理手順で到達でき、恒久的な不可視・取りこぼしは確認できなかったため、この監査ではP2に数えていない。任意の後続を先に調べられず、残件数も表示しない点は低優先度の改善候補に留める。

## 検証と飽和判定

独立probeと次の既存UI群を直列実行した。

- `post-findings-ui-data-probe.test.cjs`
- `automation-square-commerce-ui.test.js`
- `automation-dictionary-publication-ui.test.js`
- `automation-destination-ui.test.js`
- `automation-destination-workspace.test.js`
- `automation-post-commit-ui.test.js`
- `automation-saturation-ui.test.js`

結果は **96件成功、失敗0、skip 0**。SQL probeの使い捨てschemaは各試験の `finally` で削除した。ログは `post-findings-ui-data-tests.log` に保存した。

2件確定後、async選択・非表示化、保存後応答、2ページ目以降、kind/ID、owner/scope、履歴・復元、通知先作成、marketplace・辞書・Square契約/寄付を再度追跡した。Marketplaceの選択世代、辞書の保存済みread、通知先の個別再取得、Square bindingのread invalidation、契約・寄付のaction lockとidentity guardには、上記と別のP1/P2を確認しなかった。このbounded passはここで飽和とした。

