# CBTE 障害復旧用の永続状態・起動条件

2026-09-06。現在のチェックアウトと配布テンプレートを読んだ監査。ホストへの接続、バックアップ現物の確認、復元、起動、実送信は行っていない。以下の `/root/comebacktwitterembed` などは配布テンプレートの標準パスであり、停止中の本番ホストで同じ状態だったことを確認したものではない。

MySQLの論理ダンプだけでは、保存済みメディア、販売開始通知、独立管理基盤の履歴・認証・受付記録まで復元できない。復旧マニフェストには、アプリケーションの版、DBバックアップ、ファイル状態、秘密設定、外部公開経路を別々に記録する必要がある。

## 1. マニフェストに必要な区分

| 区分 | 意味 |
| --- | --- |
| 起動に必須 | 欠けるとBot・認証・対象機能を正しく起動できない |
| データ継続に必須 | 新規起動はできても、利用者データ・認証手段・操作の対応関係を失う |
| 再構築可能 | 元データや固定したソースから生成できる。バックアップ未収録でも復旧手順で生成する |
| 一時状態・そのまま再実行禁止 | 旧ホストのPID・接続・実行途中・送信待ちを、新ホストの有効な作業として扱わない |
| 外部に存在・収録未確認 | リポジトリから所在地やバックアップ収録を確定できない。別の回復手段が必要 |

各項目に `backup_id / captured_at / source_host_id / source_path / restore_path / application_revision / checksum / size / consistency_method / permissions / required / restore_action` を持たせる。DBとファイルが別の時点なら、それぞれの時点と欠落する可能性のある期間を明示する。

## 2. アプリケーションと秘密設定

| 対象・標準パス | 必要性 | 根拠・復元時の扱い |
| --- | --- | --- |
| `/root/comebacktwitterembed/` の検証済みソース一式、Gitの完全なrevision、両方の `package-lock.json` | 起動に必須 | `index.js` と `dashboard/`、`src/`、`migrations/`、`admin-agent/`、`deploy/` を同じ版で配置する。現在のroot・dashboardのlockfileはGit追跡対象。`install-runtime.sh` は `git archive HEAD` を使用するため、未コミット変更は配布物に入らない |
| `/root/comebacktwitterembed/config.json` | 起動に必須・秘密情報 | `index.js` が直接requireし、`client.login(config.token)` を呼ぶ。Botの入口では `BOT_TOKEN` 環境変数だけでこのファイルを代替できない。Bot token、Discord application/client ID・secret、公開URL、DB設定、通知Webhook、NextAuth secret、各機能の設定を保持する |
| 実際に使用したroot/dashboardの `.env*` とサービス環境設定 | 設定に応じて必須・秘密情報 | Nextの `DATABASE_URL`、`NEXTAUTH_SECRET`、`DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`、`DB_*` 等がconfig値を上書きし得る。収録の有無は今回未確認。復旧先のDB接続値を明示し、旧ホストを参照したまま起動しない |
| `/etc/cbte-admin/core.env`, `analysis.env`, `reports.env`, `executor.env`, `bot.env` | 管理基盤の起動に必須・秘密情報 | 管理token、所有者ID、worker接続先、状態ディレクトリ、公開origin、通知先、SQL registryなどを定義。現在の生成処理はroot mode `0600`。executorのuid/gidは復旧先の実アカウントから再計算する |
| `/etc/cbte-admin/bootstrap-password` | 独立ログインの回復に必要な場合がある・秘密情報 | 生成スクリプトが作る初期パスワード。現在の変更済みパスワードの正本は管理SQLiteのsettings。bootstrapだけが残っていても変更済み認証の復元とはならない |
| `/etc/cbte-admin/witness.env` または実配置したwitness設定 | 外部監視を継続する場合に必須 | witnessは別ホストに配置する。障害ホストと一緒にだけ配置してもホスト全体の停止検出を代替できない |
| `/opt/cbte-admin/releases/<revision>/cbte-admin` と `current` symlink | 再構築可能 | Go 1.25以降、固定した `go.mod` / `go.sum` からLinux ARM64向けに作り直せる。x86_64バイナリをそのまま使用しない |
| `/opt/cbte-admin/runtimes/<revision>/` と `worker-runtime` symlink | 再構築可能。ただし `config.json` の秘密値は別途必要 | 配布スクリプトはソースと両方のnode_modulesをコピーする。同じソースからARM64ホスト上で依存関係・Prismaを生成してから配置する |

根拠: `index.js:10,145`、`src/db.js:16`、`dashboard/lib/env.ts:68`、`deploy/admin-platform/install-runtime.sh`、`deploy/admin-platform/write-config.py`。

## 3. MySQL以外の利用者データ

| 対象・標準パス | 必要性 | 保存内容・互換性 |
| --- | --- | --- |
| `/root/comebacktwitterembed/saves/<userId>/<tweetId>/data.json` と同ディレクトリのメディア | データ継続に必須 | 保存した投稿本文・元応答・画像・動画・プロフィール画像。DB内の容量上限だけでは復元できない。削除済み・非公開化した元投稿は再取得できるとは限らない |
| `saves/.admin-staging/`, `saves/.admin-trash/`, `saves/<userId>/.admin-save-journal.json` | 未完了保存の整合性回復・旧版継続に必要 | 保存処理はstage、旧版退避、journal、renameを使う。journalには絶対パスがある。新しいrootやworkerのbind先に変わる場合は、そのまま解釈しない。未完了の旧版・新規版を保全して整合性を確認する |
| `saves/<userId>/.admin-save.lock` | 一時状態・そのまま有効なlockにしない | 保存元PIDだけで所有判定する。新ホストの無関係なPIDとの一致を、生存中の保存処理と解釈しない。復旧epochで旧lockを区別する |
| `/root/comebacktwitterembed/data/booth_sale_notifications.json` | データ継続に必須 | BOOTH販売開始通知の登録・通知済みフラグ・試行回数。DBとは別のJSONファイル。cwd相対の `data` を使用する。旧時点の未通知レコードは実際には通知済みの可能性がある |
| `/root/comebacktwitterembed/data/stats_counters.json` | 履歴継続に必要、欠損時は再初期化可能 | 累積処理数、時間・日単位のカウンター。欠損時は0から再開する実装。欠損を過去の実際の0件と扱わない |
| `/root/comebacktwitterembed/data/youtube_downloads/index.json` と `files/<token>/<filename>` | 短期間の既発行リンクを維持する場合に必要。再生成可能 | tokenとファイル名、元URL、作成・失効時刻。`YOUTUBE_DOWNLOAD_DIR` / configで変更可能。既定TTLは30分。日次バックアップ時点の多くのファイルは復元時点で期限切れになる |
| `/root/comebacktwitterembed/data/niconico_downloads/index.json` と `files/<token>/<filename>` | 上と同じ | `NICONICO_DOWNLOAD_DIR` / configで変更可能。既定TTLは30分。生成にはffmpegが必要 |
| `settings.json` | 現行起動には不要。旧設定の資料として保存可能 | 現行 `initializeSettings()` は `SETTINGS_STORAGE=file` を拒否する。これを復元してもMySQL設定の代わりにはならない |

保存先は `SAVES_DIR`、次に `ADMIN_SUPPORT_DATA_DIR/saves`、未指定ならrepoの `saves`。配布した分析workerは `SAVES_DIR=/var/lib/cbte-admin-analysis/saves` を使用し、systemdの `BindPaths` で `/root/comebacktwitterembed/saves` に接続する。root自身や保存階層をsymlinkに置き換えると現在の保存処理は拒否する。旧コマンド `src/providers/twitter/commands/showsavetweet.js` は `./saves/` を直接読むため、Botのcwdと実ディレクトリ配置を維持する必要がある。

保存メディアURLは `src/components/savetweet.js` に `https://twidata.sprink.cloud/data/` と固定され、保存時に `data.json` 内のURLへ埋め込まれる。この公開originの復旧・静的ファイル配信も必要。現在の `deploy/admin-platform/nginx-gateway.conf` はdashboardと `/ops/` の転送だけであり、この静的配信の設定・実ホストはリポジトリから確認できない。

根拠: `src/components/savetweet.js`、`src/adminSupport/operations.js:151`、`src/providers/booth/_notifications.js`、`src/state.js`、`src/youtubeDownloadStore.js:18`、`src/niconicoDownloadStore.js:24`、`dashboard/lib/media-delivery.ts`、`src/settings.js:958`。

## 4. 独立管理・調査・冪等性の状態

| 対象・標準パス | 必要性 | 保存内容・復元時の扱い |
| --- | --- | --- |
| `/var/lib/cbte-admin/state.db` | 管理基盤のデータ継続に必須 | 証拠event、action、incident、通知outbox、policy、password hash、ログイン情報、passkey、report snapshot、journal cursor。起動だけなら新規DBで可能だが、管理者の登録済み認証手段と過去の操作対応を失う |
| `/var/lib/cbte-admin/state.db-wal` / `state.db-shm` | SQLiteの整合性次第で必須 | `journal_mode=WAL` / `synchronous=FULL`。稼働中にstate.dbだけコピーしない。online backupまたは停止・checkpointを伴う整合したsnapshotを取得する |
| `/var/lib/cbte-admin-executor/state.db` とWAL | 操作の対応関係・重複防止の継続に必須 | 特権操作の受付・結果・再起動の回数制限。失うと過去の受付と同一操作か判別できない |
| `/var/lib/cbte-admin-analysis/*.json` | 対話操作の対応関係の継続に必須 | action IDのhash名で保存するworker receipt。起動時に `running` を `unknown` へ変え、再実行しない。コード既定値は `/var/lib/cbte-admin-analysis/state` だが、配布envは親ディレクトリを明示するため実envを正とする |
| `/var/lib/cbte-admin-reports/*.json` | 履歴継続に必要、集計内容は再生成可能 | 独立report workerのreceipt。完成済みreportの正本は管理SQLite側にも保存する |
| `/var/lib/cbte-admin-shared/provider-source-overrides.json` | 適用ポリシー・履歴継続に必要 | 取得元の切替、revision、期限、操作ID。Botとworkerが同じファイルを見る。期限切れを延長して復活させない |
| `/var/lib/cbte-admin-shared/report-queries/` のJSON・lock | 証拠として保持。一時接続としての再利用は禁止 | SQLのquery ID・接続ID・user/database・PID・期限を記録する。新ホストで旧接続IDを有効な取消対象として扱わない。旧lockと実行中表示はrecovery epochで分離する |
| `/var/lib/cbte-admin-bot-spool/` | 未転送の証拠継続に必要 | Botの `ADMIN_TELEMETRY_DIR`。`*.active`, `*.pending`, `*.corrupt` を保全し、永続受領確認後に削除する。未設定時はrepoの `logs/admin-telemetry/` |
| `/var/lib/cbte-admin-witness/state.db` とWAL | 外部監視履歴・通知outbox継続に必要 | 別ホストにあるwitness自身の状態。Bot復旧先の新設だけでは元witnessの状態は移動しない |
| `/var/log/journal/`、実配置のアプリログ | 調査証拠として必要。アプリ起動には不要 | journaldの保持に依存する。新ホストに旧journal cursorだけ持ち込むと追跡できない場合がある。旧cursorを証拠として保全し、新ホストの収集開始点を明示する |
| `/run/cbte-admin*`、Unix socket、旧PID、旧systemd InvocationID | 再生成・そのまま復元禁止 | systemdが作り直す実行時状態。旧ホストの起動IDを復旧先の再起動対象に使わない |

`state.db` のpasskeyは `ADMIN_AGENT_PUBLIC_URL` のhostnameをRP ID、scheme+hostをoriginにする。同じ公開originを維持すれば既存credentialを利用できる構成だが、originを変更して既存passkeyが使えるとは扱わない。独立passwordの回復手段も保持する。

旧 `src/errorTracking.js` のDB書き込み待ちはメモリ上のqueueで、別の永続error spoolは確認できなかった。新しい管理telemetry spoolとは別であり、メモリ上だけにあった旧event・analyticsの完全復元を主張できない。

根拠: `admin-agent/store.go:44`、`admin-agent/executor.go`、`admin-agent/analysis-server.cjs:172`、`admin-agent/passkeys.go:39`、`admin-agent/journal.go:46`、`src/adminSupport/telemetrySpool.js`、`src/adminSupport/providerSources.js:20`、`src/adminSupport/reportQueries.js:8`、`src/errorTracking.js:1374`。

## 5. 日次バックアップからそのまま再実行してはいけないもの

1. **古いqueued action**: coreの `recoverActions()` は `running` だけを `unknown` にし、`queued` は実行可能なまま残す。バックアップ取得後に本番で実行済みになっていたactionを、古いsnapshotから再実行する可能性がある。復旧由来のqueued/runningを隔離し、元の受付ID・操作種別・結果資料を保全する。既知の読み取り・再生成だけを新しい復旧epochで起動する。
2. **通知outboxとBOOTH未通知状態**: 旧snapshotで未送信でも、その後に送信済みの可能性がある。通知の再開方針にRPOと重複の扱いを含める。
3. **SQL取消・保存lock・journal・spoolのPID所有判定**: 新ホストでは同じ数値のPIDが別プロセスに割り当てられる。旧PIDが存在するだけで、旧作業が生存すると判断しない。保存journalには絶対パスの検証もある。
4. **二重Bot起動**: 現行Bot入口には、独立した災害復旧leader leaseやホスト間のfencing処理がない。旧ホストがネットワーク分断から復帰した場合にも、2台が同時に同じBot tokenで処理しない仕組みが復旧基盤側に必要。公開URLの向き先変更だけではGateway処理の二重化を防げない。
5. **過去の権限・到達性判定**: 旧DB・ログのDiscord権限、公開probe成功、systemd状態を新ホストの検証結果として扱わない。

日次バックアップのRPOより新しい処理・保存・設定変更は、DBにもファイルsnapshotにも存在しない可能性がある。取得できない範囲を明示し、0件・成功・未実行へ変換しない。

## 6. MySQLの復元境界

- `src/lifecycle/dbBackup.js` の内蔵バックアップは、既定でrepoの `data/db_dumps/<timestamp>_<database>.sql.gz`。`--single-transaction --quick --routines --events --triggers` を指定し、対象は一つのアプリDB。これはNASの暗号化日次バックアップとは別経路であり、内蔵ダンプがNASへ転送される実装は確認していない。
- 内蔵dumpは最終ファイル名へ直接書き込むため、失敗時にも不完全なファイルが残り得る。ファイル名の新しさ・存在だけで採用せず、完了証拠、圧縮の整合性、復元検証を確認する。
- デフォルトの実行時刻はプロセスローカル時刻の03:00。`DB_DUMP_HOUR`, `DB_DUMP_MINUTE`, `DB_DUMP_DIR`, `DB_DUMP_DISABLED`, `DB_DUMP_RUN_ON_START`, `MYSQLDUMP_BIN` で変更できる。OCIでUTCのまま起動するとJST想定とずれる。
- 全アプリ表、`schema_migrations`、設定・除外対象・禁止語・ボタン設定、利用枠、Webhook、自動展開登録、委任アクセス、管理操作receipt、集計・監査・レポート表を復元する。DBユーザー・パスワード・grantsは単一アプリDBのdumpだけでは揃わない。
- Bot DB接続は `DB_HOST / DB_USER / DB_PASSWORD / DB_DATABASE / DB_CHARSET` またはconfigを使用。dashboardはこれらか `DATABASE_URL` を使用する。dashboardの組み立てURLはport3306固定なので、別portを使う場合は `DATABASE_URL` を明示する。Botの資格情報には現在port指定の経路がないため、3306以外を当然に使えると扱わない。
- Botは `mysql` パッケージを使う。新DBの認証方式、アプリuserの接続、SQL方言・照合順序・DEFINER・trigger権限を実際に確認する。元DBのバージョンをdump metadataから確認し、MariaDBや別世代MySQLへの無検証の置換を避ける。
- 正確な件数用の基準値・差分と8表のtriggerを検証する。通常のBot起動では大規模COUNT・triggerのインストールを行わない。欠損時は `scripts/manage_table_counts.js` の `install / seed / verify / status` を使用する設計で、未初期化のまま正常なレポートと判断しない。
- 復旧ソースの `migrations/` と `src/db_schema.js` を固定し、復元した版との差分を記録する。起動時のschema migrationとMySQL初期化は実際のDB書き込みを伴う。

根拠: `src/lifecycle/dbBackup.js`、`src/db.js`、`src/databasePool.js`、`dashboard/lib/env.ts:68`、`src/db_schema.js`、`docs/exact-table-counts.md`。

## 7. OCI Linux ARM64での再構築・配布前提

- Node.js **22.12.0以上**が必須。現在の `src/runtime.js` はBunを明示的に拒否する。Ubuntu標準パッケージのNodeが条件を満たすか確認する。
- rootとdashboard両方で対象ARM64環境向けに依存関係をインストールする。x86_64/Windowsのnode_modules、Next SWC、Prisma engineをコピーして利用しない。dashboardのPrisma schemaはbinaryTargetsを固定していないため、復旧先で `prisma generate` を実行する。
- dashboardとheadless report workerにはTypeScriptやPrisma CLIを含む依存関係が必要。`--omit=dev` で必要なruntime loader/build依存を削らない。
- Nextの `.next*`, `.next-builds/<buildId>/`, `.next-builds/current.json`, `.tsbuildinfo` は再構築可能。復旧先でproduction buildを作成し、対応するcurrent pointerを生成する。旧platformのbuild pointerだけを復元しない。
- 管理Go binaryは `CGO_ENABLED=0 GOOS=linux GOARCH=arm64`、Go 1.25以降で作る。SQLiteはpure-Goのmodernc driver。Linux固有のprocess group、Unix peer credentials、systemd/journald、`/proc`・PSI等を利用する。
- Niconicoの生成にはARM64版ffmpegが必要。YouTubeは既定で `https://yt-dlp.arcdc.jp` の外部APIを利用するため、ローカルyt-dlp binaryのインストールだけでこの依存を満たしたことにはならない。
- 配布スクリプトは **root実行、ソースの実パス `/root/comebacktwitterembed`、Nodeの `/usr/local/bin/node`** を前提とする。アカウント作成・journalグループ・ACL付与・bind mount・symlink・systemd StateDirectoryを準備する。Ubuntu上で `python3`, `tar`, `git`, `setfacl`, `ffmpeg`, MySQL関連client、nginx、cloudflaredなど実際の利用コマンドが揃うことを確認する。
- `cbte-admin` のuid/gidを再作成後にexecutor設定を作り直す。保存データへのACLとdefault ACL、状態ディレクトリの所有者・0700、秘密envの0600を検証する。

根拠: `package.json`、`dashboard/package.json`、`dashboard/prisma/schema.prisma`、`dashboard/scripts/start-dashboard.js`、`admin-agent/go.mod`、`admin-agent/README.md`、`admin-agent/process_linux.go`、`deploy/systemd/`、`deploy/admin-platform/install-runtime.sh`。

## 8. 起動とreadinessの判定順序

1. **復旧世代と排他を確定**: 採用backupのchecksum・完了marker・取得時刻、DB版、アプリrevision、欠損ファイルを記録。旧Botとの二重処理を防ぐ条件を満たしてからGateway loginを許可する。
2. **DBとファイルを復元**: MySQLのschema/data/grants、config、saves、管理SQLiteの整合性、worker receipt、共有設定を復元。旧実行中・送信待ち・PID依存情報を新規作業として再生しない。
3. **対象CPU向けにruntimeを準備**: Node/Go/Prisma/Next/ffmpeg、サービスuser・ACL・state dir・symlink・環境設定を検証。`install-runtime.sh` 自体はサービスや公開経路を切り替えない。
4. **独立管理を先に起動**: executor → analysis worker(30990) / report worker(30991) → core(30988)。新規ローカルSQLiteへの書き込み、worker health、coreのAPI/認証、通知先設定、Unix socketを確認する。witnessは別ホストから監視する。
5. **Botを起動**: `index.js` は `ensureDatabaseSchema → initializeSettings → dashboard prepare/build → dashboard start → handler登録・daily dump予約 → Discord login` の順。DB初期化に失敗すれば通常dashboardもその入口からは起動しない。dashboard prepare失敗時はdashboardを省略してBot loginへ進むため、Bot readyだけでWeb正常とはしない。
6. **公開HTTPを確認**: テンプレートはnginx30987 → Next30989、`/ops/` → core30988。新設の `GET /api/health` は `{ok:true, scope:'dashboard_http_only', time}` のみ返し、DB・Discord・認証へ接続しない。この成功をBot readinessとは扱わない。
7. **Bot自身のreadinessを確認**: 新ホスト・新bootの15秒周期telemetry heartbeat、`details.ready=true`、Gateway状態、記録spoolの永続化・転送、DB接続、queue状態を確認。過去backupに含まれたheartbeatやHTTP200では合格にしない。
8. **機能別に確認**: 所有者の管理画面、設定取得、URL検証、保存済みデータの参照、既発行media tokenの有効期限とファイル対応、完全reportの生成結果を確認する。read-onlyの確認と実送信の成功証拠を区別する。

起動後の副作用: Discord ready handlerはglobal slash commandsを再登録し、deregister通知、統計投稿、console Webhook転送、BOOTH通知、error通知、media cleanupを開始する。Botはユーザー投稿への展開・一部の指定チャンネルでのcrosspost/reactも行う。DRの試験環境を本番tokenで無条件に起動しない。

## 9. バックアップ収録を別途確認する必要がある外部依存

- Cloudflare Tunnelの認証情報、connectorの実systemd設定、DNS/公開hostnameの管理権限。実際の設定ファイル所在地はこのrepoから確認できない。
- `cbte.sprink.cloud` と保存用 `twidata.sprink.cloud` のorigin、Discord OAuth callbackの登録先。public origin変更はNextAuth/CSRF/passkeyにも影響する。
- NASへ到達する経路・資格情報、暗号化dumpを検証・復号する鍵。NAS側ファイルの所在・最新backupの完了状態は今回未確認。
- OCIのinstance・volume・network・API認証と、旧ホストのfencing・復旧lease。これらは既存CBTEソースの永続状態に含まれない。
- 利用している外部取得APIの到達性・必要な資格情報・IP制限。Discord側のBot membership、Message Content intentの許可、各チャンネル権限は同じBot identityを復元しても実環境で再確認する。

今回の監査から、既存NAS日次backupが上記を全て収録しているとは結論できない。収録されていない必須項目は、回復可能な別の正本を明記するか、データ欠損として扱う。
