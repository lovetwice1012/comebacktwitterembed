# 管理レポートのタイムアウト調査

2026-09-22。本番ダッシュボードの認証済み画面と、本番SSHから読み取り調査した。認証情報はこの記録に含めない。

## 確認できたこと

- ダッシュボードでレポート取得時に `The operation was aborted due to timeout` を確認。管理APIのヘルス取得も一時的にタイムアウトした。
- ブラウザーの通信計測では管理カタログ171ms、ヘルス取得2,974msと20,601ms、保存済み概要レポート7,721msを観測した。計測ごとに変動しており、常時停止ではない。
- `cbte-admin.service` はMemoryHigh=192MiB、MemoryMax=384MiB。MemoryCurrentは402,542,592〜402,575,360 bytesと上限付近。プロセスのVmSwapは約2.1〜2.9GiB。メモリ上限到達の記録も増加していた。
- 管理サービスのNRestartsは1,235。直近1時間のjournalにwatchdogタイムアウトと再起動が複数記録されている。
- 同時点でホストには約106GiBの利用可能メモリがあり、ホスト全体のRAM不足と管理サービスの個別制限を区別する必要がある。
- 管理状態DBは約24.3GB、WALは約9.1GB。データ削除はしていない。表ごとのサイズ集計は時間がかかったため、その読み取り診断だけを中止した。
- レポート専用workerは待機状態で、MemoryCurrentは約18MB。管理APIの遅延をレポートSQLの実行時間と同一視しない。

## 保存されていたレポート

- overview: 2026-09-15の完成版を保持。その後の更新が `INVALID_WORKER_RESULT`。実際の下位エラーは独立workerとの通信中断。
- analytics: 同じくworkerとの通信中断。workerの永続受付記録にも `WORKER_INTERRUPTED` が残る。
- guild-preview: 2026-09-07の完成版を保持。
- provider-preview: 2026-09-15の完成版を保持。

調査時のポリシーは自動更新が無効。I/O圧迫による生成一時停止も記録されていた。古いレポートが表示できることと、新しいレポートを正常生成できることは別に検証する。

## 対応状況

ユーザーの恒久変更の承認を受け、2026-09-22 16:45 JSTに `systemctl set-property cbte-admin.service MemoryHigh=4G MemoryMax=6G` を適用した。`/etc/systemd/system.control/cbte-admin.service.d/50-MemoryHigh.conf` と `50-MemoryMax.conf` の永続設定、実効値4,294,967,296 / 6,442,450,944 bytesを確認した。適用前後でMainPID=1760530、NRestarts=1237は変化しておらず、この変更によるサービス再起動は行っていない。OS・Botの再起動やデータ削除も行っていない。

筐体はOSから125GiBが認識され、適用直前の利用可能メモリは106GiB。配備用の `deploy/systemd/cbte-admin.service` も同じ4GiB / 6GiBへ更新した。

9月27日の継続観測で、管理デーモンのcgroup使用量が6GiBに近づいた。ホストの空き容量とBotの実使用量を再確認し、恒久設定をMemoryHigh=12GiB、MemoryMax=16GiBへ拡張した。永続drop-inと実効値を確認済みで、MainPID=1760530、NRestarts=1237は変更されていない。デーモン・Bot・OSの再起動は行っていない。

4種類のレポートの再生成を受付済み。受付は完了ではなく、I/O圧迫による一時停止の終了、完全な生成結果、公開画面での取得を確認中。

変更後、管理プロセスのMemoryCurrentは約783MBまで利用できるようになった。`/proc/pressure/memory` のfull avg10は0.05%、`/proc/pressure/io` のfull avg10は1.14%まで低下した（変更前の観測はそれぞれ約45.5%、50.7%）。NRestartsは1237のままで、この時点で新たな再起動は発生していない。

変更後の保存済み概要レポートGETは、連続3回の実測でHTTP 200、622ms / 152ms / 167msだった。同時のhealth取得は60ms / 2473ms / 39ms。どちらもデータや項目を削って測定したものではない。負荷保護の期限は自然に終了し、07:49:23 UTCにoverviewの生成が開始された。

## 再生成で確認した別のSQLボトルネック

メモリ変更後、analytics、guild-preview、provider-previewは新しい完成版の保存まで成功した。overviewには別の集計ボトルネックが残り、レポート全体の600秒の実行予算を使い切った。

登録済みSQLの実測では、設定変更後のユニーク利用数を求める集計が179.749秒を占めていた。同じ設定に対する監査記録の重複した7日間の期間を、それぞれ読み直す形になっている。修正案は、ユニーク数を求める部分だけで同じ設定・対象の重複期間を統合し、既存のサーバー別インデックスを使う。設定変更ごとの加算指標を求める別の集計は変更しない。

重なり・接する期間・隙間・別設定方向・対象範囲・NULL・同じ利用者の重複を含む一致テストと、完全レポートの構造・失敗時の扱いを確認する関連15テストが成功。

本番の固定条件・同じRepeatable Readスナップショットで比較した結果、変更前140,424ms、変更後21,283ms。618行すべてが一致し、正規化結果のSHA-256も `f61b163e5b8ab85104378c444494920fae760db3e075645e487b9ed660e8e010` で一致した。順番は変更前→変更後であり、キャッシュが温まる影響を含む実環境での比較値。実行計画と測定結果は `docs/benchmarks/setting-attribution-unique-production-2026-09-22.json` に保存する。

08:22:08 UTCに、稼働report runtime内の `dashboard/lib/setting-attribution-query.ts` と呼び出し元 `dashboard/lib/admin-data.ts` の該当部分だけを反映した。適用前のハッシュと `git apply --check` を確認し、元ファイルを `/opt/cbte-admin/hotfix-backups/20260922-report-15095d99` に保存した。適用後の生成SQLが比較試験と一致することも確認済み（CRLF/LFのみ正規化）。新しいworkerプロセスが修正を読み込むため、サービス再起動は行っていない。概要レポートを操作ID `4d2b85b3aecadeb2849ed6dd430710abe8fb52a8f5b950d5` で再生成中。

最終確認では、概要の新しい完成版が2026-09-27 07:28:08 UTCに保存された。4種類すべてが`status=succeeded`、`cache.ready=true`、`lastError=null`で認証済み管理APIからHTTP 200を返した。取得実測はanalytics 195ms、guild-preview 111ms、overview 415ms、provider-preview 185msだった。概要レポートは今回の修正後に生成し、サイズは1,653,328 bytes。管理デーモンはMemoryHigh=12GiB、MemoryMax=16GiBで稼働し、NRestarts=1237のまま維持された。

## ローカルの再発防止修正

本番に保存された通信切断エラーと、クライアント側のタイムアウト後も読み取りを待ち続ける経路に対して、失敗するテストを先に作成した。

- レポートの取得・生成受付はHTTPリクエストの取消しをSQLiteの接続待ち・照合・受付トランザクションに伝える。これらの受付処理は5秒を上限とし、バックグラウンドでの完全レポート生成時間は変更していない。
- 独立workerの通信が途中で切れた場合は `WORKER_TRANSPORT_FAILED` として記録し、JSON解析エラー・受信バイト数・既存の操作IDも保持する。変更操作の成否不明状態は維持する。
- 修正前は新しい取消し試験と通信切断試験が失敗し、修正後は `go test ./... -count=1` が成功した。

これらはローカル修正であり、本番にはまだ反映していない。メモリ制限による本番の圧迫解消と、4種類すべての新しい完全レポート生成・公開画面での取得確認は未完了。
