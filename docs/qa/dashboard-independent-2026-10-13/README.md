# 2026-10-13 本番ダッシュボードの分離と新UIの選択

本番反映済み。実際のBot再起動中も、公開health・ホーム・認証APIの327応答がすべてHTTP 200だった。ダッシュボードwrapper PID 1624533、Next PID 1624541は再起動前後で変わらず、独立サービスの再起動回数は0。BotはPID 1727905で復帰し、13シャードすべて接続、記録失敗なしを確認した。

停止原因はYouTube streaming対応の配布処理による `systemctl restart cbte.service`。操作記録は07:17:16.760 UTC、guardian設定の更新は07:17:21.058825 UTC、サービス停止は16:17:21.075977 JSTで一致する。ダッシュボードはBotの子プロセスで同じsystemd control-groupに所属していたため、Bot終了処理とサービス停止で一緒に終了し、16:19:56までHTTPが戻らなかった。対象期間のkernel OOM記録は0。

現在は `cbte-dashboard.service` が127.0.0.1:31089を独立して管理する。Botとの `PartOf` / `BindsTo` / `Requires` 依存はなく、自動起動と障害時の再起動を設定した。Botには外部管理・旧起動処理停止・統合メディア維持のdrop-inを適用した。既存Botリリース、guardianの起動証明、作業中のソースは変更していない。次回のコード配布向けにはBot lifecycleにも外部管理の処理を実装した。

旧UIの通常画面上部に「新しいダッシュボードを使う」トグルを表示する。ログイン済みの通常ユーザーがオン／オフでき、選択はアカウントに結び付いた署名付きHttpOnly cookieでこのブラウザに保存される。未選択の通常ユーザーは旧UI。796972193287503913は新UIが初期値で、明示的なオフも可能。未ログインでは非表示。サーバーや管理者の権限は変わらない。

起動許可の再取得中もHTTP・認証・UI cookie操作は応答する。業務データの変更はHTTP 503で拒否し、許可が戻るとNextを再起動せず再開する。トランザクションは開始時のguardian epoch/instanceを保持し、変更時はcommit前にrollbackする。すでに送信済みのCOMMIT/DDLやファイル削除まで原子的に止めるDB epoch CASを追加したものではない。

検証はNode 57件、配布手順Python 14件、ブラウザ20確認、隔離Nextの権限制御12確認、実環境でのUI cookie切り替え12確認、アカウント別表示8確認。Node 57件のうち3件は破棄可能なローカルMariaDBのSQL試験。本番DBの変更試験はしていない。認証済み表示の試験は短命な署名付き合成セッションを使い、実OAuthログインとは区別している。

観測スクリプトの初回raw結果には1件の判定誤りがある。許可なしのhealth応答と、直後に許可を再取得したPOST応答を同じ時点として比較し、正常な404を失敗扱いした。次の観測は許可ありで404、隔離Nextの実HTTP試験では許可なしのPOST/PATCH/DELETEすべて503。raw記録を保持したまま、HTTP継続・PID不変の判定を `continuity-assessment.json` に分けた。今後の観測スクリプトはこの境界でhealthを再取得する。追加の本番Bot再起動はしていない。

配布の詳細は [deployment.json](production/deployment.json)、移行前の設定保存と操作は [prepare.json](production/prepare.json) / [promote.json](production/promote.json)、継続性は [continuity-assessment.json](production/continuity-assessment.json)。40ファイルの限定差分と、旧UIの固定59ファイルの一致を実環境で確認した。同時進行の自動展開UI変更は配布していない。automation-serverには固定済み旧ソースに対するDBガード2行だけを適用した。
