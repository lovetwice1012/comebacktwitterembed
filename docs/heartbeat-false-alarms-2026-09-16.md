# 2026-09-16 進捗停止通知の再発調査

## 結論

21時台以降の `bot.heartbeat.stale` の繰り返しは、管理デーモンが古いDB読み取り状態と最新の状態を交互に参照していたことに起因する。Botの進捗記録は保存され続けていた。通知閾値や通知の送信先を変えず、heartbeatの読み取りを共有の分析用接続から分離する修正を作成し、ユーザー承認後に本番へ反映した。2026-09-16 23:26:02 JSTから修正版で稼働し、最新記録へ追いついてから30分15秒・112回の監視で誤判定の再発がないことを確認した。

この結論の対象は夜間の進捗停止通知であり、同日に出た公開HTTP・起動時のプロセス確認・プロバイダ異常まで誤検知と断定するものではない。

## 本番での確認結果

調査は2026-09-16 23時台JST。SQLiteは `mode=ro` と `PRAGMA query_only=ON` を使用し、期間・件数・実行期限を制限した。

- BotはPID `3359855`、boot ID `8aca5f58-652f-468f-add6-9f76807357e0` を維持。21:00〜23:00のheartbeatは15分あたり59〜60件で、45秒を超える発生時刻の空白はなかった。対象行はすべて `ready=true`。
- 上記heartbeatの発生からDB保存までの最大遅延は59.1秒。監視の停止閾値は180秒。
- 21:00〜23:04のBot journalには123件のperformance記録があり、処理完了数は20,946から24,870へ増加。event loop P99の最大値は122ms。
- 最初の集計に含まれた484件の監視snapshotのうち、heartbeat ageが180秒超だった206件は、Botプロセス確認済み・ローカルHTTP 200・公開HTTP 200だった。
- 後続の499件のsnapshot集計では、heartbeat参照時刻の逆行を126回確認。180秒超として読まれた213件はすべて同じ `21:09:20.925 JST` の記録だった。見かけ上の最大経過時間は7,012.8秒。
- 夜間の該当outboxはそれぞれ `accepted`、`attempts=1`。同じincidentがConfirmed/Resolvedへ繰り返し遷移しており、送信リトライによる重複ではない。

具体例（JST）:

| 監視時刻 | 監視が読んだheartbeat | 状況 |
| --- | --- | --- |
| 21:09:58 | 21:09:35.929 | 最新付近の記録を参照 |
| 21:10:13 | 21:09:20.925 | 過去の記録へ逆行 |
| 21:16:28 | 21:09:20.925 | 約427秒停止と判定。同時点で21:16:06.079の記録は21:16:28.031に保存済み |

調査開始時の管理デーモンの実行バイナリはrelease `a62e9b5f7b242c56c49f2ef76de391246259b8f4`。このrevisionの `latestHeartbeat` は、分析APIと共有する4接続の読み取りプールを使っていた。

## 原因の確度と範囲

最新記録が保存済みなのに監視が過去の同一記録へ逆戻りする現象は、本番のeventsとmonitor.snapshotを照合して確認済み。

古いWAL snapshotを保持した接続がプールへ戻る状況をテストで作ると、修正前の実装でも同じ古いheartbeat参照を再現できた。SQLiteの読み取りtransactionは終了するまで開始時のsnapshotを参照する（[SQLiteの仕様](https://sqlite.org/isolation.html)）。

本番でその古い読み取り状態が残った最初の契機までは特定していない。使用中の `modernc.org/sqlite v1.36.1` のキャンセル時の後始末も調査候補だが、ライブラリの特定の競合が本番で発生したと断定しない。今回の修正では依存ライブラリを更新しない。

## 修正内容

- heartbeat専用の読み取りプールを作り、`mode=ro`、同時接続数2、idle接続数0とする。
- 一回の読み取りが終わると接続を閉じ、次回は新しいDB読み取り状態を取得する。
- 既存の最新heartbeatテーブルと2秒の監視読み取り期限を維持する。
- 停止・復旧の閾値、通知形式、送信先、通知回数制限は変更しない。
- Store終了時に専用プールも閉じる。

## 検証

- 修正前: `TestHeartbeatDoesNotReusePinnedAnalyticsSnapshot` が期待どおり失敗。10分前の記録を最新として返すことを再現。
- 修正後: 同テストで3回の新規heartbeat保存すべてについて最新時刻を取得。
- `TestHeartbeatStillReportsRealStaleness`: 本当に10分間更新がない場合は古い時刻をそのまま返し、停止検知の根拠を維持。
- 既存のheartbeat・診断用heartbeat除外のテストを含む対象テスト成功。
- Windows/amd64、Go 1.27.1で `go test ./... -count=1` と `go vet ./...` 成功。
- `GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath` 成功。
- LinuxビルドSHA-256: `b9d52497606aa9ba508a0b07d3ed36a400fb95dd1dbece2833d2f64dd462514f`。

上記テストは本番DBを変更しないローカルの一時DBを用いた。Linux本番での実行結果は以下に記す。

## 本番反映時の確認

管理デーモンの差し替えと再起動の承認後、現行revisionとサービス状態を再確認し、旧バイナリに戻せるversioned releaseとして反映する。管理デーモンの停止中は管理画面と監視に短い中断が生じる。

反映後はバイナリのSHA-256、サービス起動、管理health、最新heartbeatと監視snapshotの一致、古い参照への逆行がないこと、真の異常検知の維持を確認する。再発間隔を踏まえ、少なくとも30分の観測を完了するまでは本番で解消したと断定しない。

## 本番反映と起動時のWAL処理

- 配布revision: `3b9091163800e8833f3dde3e6fd7eb28383667ad`。
- バイナリSHA-256はローカル成果物・転送先・実行中プロセスで一致。
- 旧releaseを保持し、`/opt/cbte-admin/current` のsymlinkを原子的に切り替えた。rollback記録は `/etc/cbte-admin/rollbacks/20260916T141831Z-heartbeat-freshness/manifest.json`。
- 初回切替では、管理デーモンがWALの自動checkpoint内で停止し、120秒のwatchdogが発火。goroutine dumpで `monitorOnce -> ingestContext -> Tx.Commit -> sqlite3WalDefaultHook -> walCheckpoint -> pread` の待機を確認した。
- 一度旧版へ戻したが、DBへの取り込みは停滞したまま。約1.6GiBのWALが残り、未反映更新ログの処理に大量のI/Oが発生していた。
- 管理デーモンを停止し、SQLite標準の `wal_checkpoint(TRUNCATE)` で更新ログをDB本体へ反映。23:25:18〜23:26:02 JST、43.696秒で完了した。WALは1,743,332,712 bytesから0 bytesになり、eventsの最大sequenceは前後とも5,546,899で変化なし。論理レコードの削除・schema変更は行っていない。
- 23:26:02 JSTに修正版を起動。PID `3067055`、管理 `/livez` と `/healthz` が200、公開 `/ops/healthz` とBot `/api/health` も200。
- Botのunit MainPID `3336259`、実PID `3359855`、primary epoch 9とinstance IDは維持された。
- 起動前の記録取り込みの遅れで23:26:32にプロセス確認不能の通知が一度発生し、23:28:52に復旧。23:27:02の新しい監視snapshotから最新記録へ追いついた。

## 最終確認

連続観測区間は2026-09-16 23:27:02.336〜23:57:17.554 JST（1,815.2秒）。監視snapshotは112件。

| 確認項目 | 結果 |
| --- | --- |
| heartbeat参照時刻の逆戻り | 0件 |
| heartbeat ageが180秒を超える停止判定 | 0件 |
| snapshot内のheartbeat観測不能 | 0件 |
| snapshot内のローカル・公開HTTP失敗 | 0件 |
| 管理デーモンの再起動 | 0回、PID 3067055を維持 |
| heartbeat age最大 | 81.7秒 |
| WAL最大サイズ | 5.2MiB |
| 観測期間内の新たな障害発生通知 | 0件。起動直後のプロセス確認不能の復旧通知のみ |

23:59:20 JSTの最終確認でも実行中バイナリのSHA-256は配布物と一致し、管理ローカル・管理公開・Bot公開healthはすべて200。Bot PIDとboot IDは変わらず、13 shardすべてonline、処理待ち0、記録の拒否0、記録エラーなし。`bot.heartbeat.stale` と `bot.workload.unverified` はともにResolved。停止閾値180秒も維持されている。

起動後のjournalには監視snapshot保存の `context deadline exceeded` が1件あった。上記期間のサービス再起動・health失敗・誤通知再発はなく、次の監視サイクルで進行している。全サイクルが無遅延だったという結果ではない。

保存した証拠:

- [配布manifest](evidence/heartbeat-20260916/manifest.json)
- [WAL反映結果](evidence/heartbeat-20260916/checkpoint.json)
- [30分観測の集計](evidence/heartbeat-20260916/verification-summary.json)
- [継続観測JSONL](evidence/heartbeat-20260916/verification.jsonl)
- [最終サービス・HTTP・Bot状態](evidence/heartbeat-20260916/deployment-final.json)

同じ原本は本番のrollback directoryにも保持している。
