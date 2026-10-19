# YouTubeのリリース・コミュニティ投稿

## 変更範囲

`youtube/autoWatch.js`の動画取得に、所有チャンネルを検証する`youtube/watch-tabs.js`を追加する。リリースは既定オン、コミュニティ投稿は既定オフ。Webの登録・編集・確認画面と一覧に同じ設定を表示する。Xの登録・枠・通知処理は変更しない。

`auto_watch_targets`へ、次の6列だけを追加する。新規テーブルや決済連携は追加しない。

- `youtube_include_releases`は既定1。
- `youtube_include_community`は既定0。
- `youtube_releases_since_ms`と`youtube_community_since_ms`は有効化時刻。古い永続バックログを新たに有効化した対象へ配信しない。
- `youtube_releases_baseline_at_ms`と`youtube_community_baseline_at_ms`は対象別の初回確認時刻。オンへの変更と監視の識別情報の変更では基準を取り直す。

sourceの`state_json.youtubeTabs`は追加取得経路の初回確認を記録する。初回のIDは`baselineItems`としてrunnerへ渡し、既存のcursorへ原子的に保存する。source全体の初回基準とは別に、対象別の追加欄の基準も同じトランザクションで保存する。ローカルのバックログ処理だけではこの基準を更新しない。

## 適用前の確認

本番反映には運用者の承認を得る。実行中releaseのSHA、lease、PID/cwd、Bot・Dashboard両方のrevisionを記録し、既存の配布・切替・切り戻し手順を使う。

1. DBのschema migration履歴、`auto_watch_targets`の列と件数を読み取り、バックアップを取得する。
2. `20261020_add_youtube_watch_options.sql`を既存のschema runnerで適用する。列確認を行う既存のmigration処理により、新規DBと既存DBの両方に対応する。DDLの暗黙commitに備え、途中失敗時は列の有無を確認して再実行する。
3. 既存の対象のリリースが1、コミュニティ投稿が0で、監視ID、通知先、枠配分、プランが保持されていることを確認する。
4. BotとDashboardを同じ検証済みrevisionへ切り替える。公開範囲・共通禁止語の設定は引き継ぐ。
5. 初回確認後に、sourceの追加欄基準と対象別基準、失敗コード、次回確認予定を確認する。初回の過去分の一斉通知がないことを確認する。
6. Webで保存・再読み込み・編集競合を確認する。実際のDiscord送信試験は、通知先と送信範囲の許可を別に確認して行う。

通常のYouTube確認では、handle解決、RSS、uploadsフォールバック、リリース、投稿欄を合わせて最大5経路を使用する。既存のリクエスト予約とペーシングに5単位を予約する。隔離ワーカーの期限はYouTubeのみHTTP期限の5倍＋10秒、source leaseは少なくともHTTP期限の5倍＋30秒にする。確認間隔と通知待遇は既存の設定を使用する。

## 切り戻し

以前の検証済みBot・Dashboardのreleaseへ戻す。追加6列、source状態、監査履歴、通知履歴は残す。旧コードは追加設定を参照せず、既存の動画取得を続ける。マイグレーション履歴やcursor、既存の対象を削除・初期化しない。

追加列を削除する切り戻しは通常不要。削除が必要な場合は別途承認とバックアップを用意し、実行中コードが参照していないことを確認する。バックアップ全体の上書き復元は、反映後の登録や通知履歴を失うため行わない。

## 検証

自動テストは使い捨てMariaDBの`127.0.0.1:33621`で実行する。`NODE_ENV=test`と`AUTOMATION_TEST_DB_PORT=33621`を明示し、SQLテストがスキップされていないことを確認する。

```powershell
$env:NODE_ENV='test'
$env:AUTOMATION_TEST_DB_PORT='33621'
node --test --test-concurrency=1 scripts/test/autoWatch.youtube-tabs.test.js scripts/test/autoWatch.youtube-tabs-sql.test.js scripts/test/automation-youtube-options-ui.test.js
node scripts/probe-youtube-watch.cjs UCvhViFXvb5Y83YGEpRX1cvg aqVt_zlAwK8
```

公開ページの読み取り証拠、回帰テスト、型検査、lintは`docs/qa/youtube-tabs-20261020/`へ保存する。公開GETやローカルの隔離処理・SQL・React DOM試験の成功は、本番反映やDiscordへの配信成功の証明とは区別する。
