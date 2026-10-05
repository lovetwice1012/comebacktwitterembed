# 2026-09-10 OCIからメインへの切り戻し修復

本番操作はユーザーの明示承認後に実施。2026-09-10 18:38 JSTにメインへの切り戻しを確認。以下は実機の記録。

## 原因

- 手動予約 `d06bf58442bcec6cc3f283f9b80c089ab1783804940625b1` は受付済み・実行中だった。
- coordinatorは `WAITING_PRIMARY` で `Primary snapshot or database validation is incomplete` を繰り返していた。
- 実DBは40テーブルだが、配置済みコードは39テーブルとの完全一致を要求していた。
- 参照する復元完了記録とスナップショットは9月7日のものだった。配置済みcoordinatorには最終同期の実処理がなく、判定だけ通す修正はデータを引き継げない。
- OCI workloadには7回の再起動記録がある。最後の自発的なSIGKILLの根本原因は未確定であり、OOMと断定していない。

## 保全と同期

- OCI保全先: `/var/lib/cbte-recovery/failback/repair-20260910/`
- メイン保全先: `/var/lib/cbte-failback/repair-20260910/`
- メイン旧DBの暗号化バックアップ: `primary-before.sql.zst.age`、983,291,577 bytes。復号・zstd検証・SHA-256照合が成功。
- 既存の保存ファイルは原位置に保持し、rsyncで更新する同名ファイルを`overwritten-saves` / `overwritten-data`へ退避する。途中まで生成した大容量tarは`primary-files-before.incomplete.tar.gz`として区別し、バックアップ証拠に使用しない。
- OCIのcontroller/coordinatorを停止して予約の並行実行を防止。workload停止後はDBを`super_read_only=ON`にし、実行中トランザクションがないことを確認して最終dumpを取得。
- 最終DB暗号文: `source-final.sql.zst.age`、1,009,689,773 bytes、SHA-256 `1cd200904e3b9bc5edfa9a6823a2bbcbcf6ae7c6c2da28394d9790865fc34f1b`。
- 保存・通知抑止・OCI実行状態のtar: `source-files.tar.gz`、SHA-256 `d76bc8264a95a6a9c16ef8942aa6f1109a3cba9896955cd34de6e4349c00ca63`。OCI/メイン両側で一致。
- OCI停止時の主要件数: guilds 17122、users 36、providers 23、guild_provider_settings 18583、guild_provider_banned_words 185、auto_extract_targets 28、deregister_notifications 0、global_settings 0、schema_migrations 22。

## 修正

- テーブル数39の固定条件を削除。今回の操作ID・OCI epoch・メインboot ID・最終暗号文ハッシュ・テーブル一覧・復元検証記録を照合する。
- 準備確認から管理workerの起動を除去。所有権移譲前に復元DBへ書き込ませない。
- メインでも既存の完了済みOCI bootstrapを読み込めるようにし、元の通知抑止開始時刻を保持する。メインで状態を新規初期化したり未完了の状態を使用したりすることは拒否。
- 最終コピー記録は既存スナップショットから自動的に生成しない。新しい手動予約には、その操作に対応する新しい最終同期・検証が必要。
- 切り戻し後の予備系には`minimumPrimaryBackupTimestamp`を設定し、メイン待機中に取得された古いDBを取り込んだり昇格候補にしたりすることを禁止する。新しいバックアップ待ちは60秒間隔で再確認する。
- メインの`ADMIN_SUPPORT_DATA_DIR`は`/var/lib/cbte-admin-shared`だが、その配下の`saves`が存在しなかった。既存の`/root/comebacktwitterembed/saves`を共有先へbind mountし、Bot・管理workerで同じ保存先を使用する。mountはsystemdで永続化し、保護された管理workerからのアクセスを維持する。
- メインのTunnelは`localhost:30987`、起動したダッシュボードは30989番だったため公開検証が502となった。`/etc/nginx/conf.d/cbte-dashboard-origin.conf`にループバック限定の中継を追加し、`nginx -t`とreload後に内部・外部応答を検証。再配置用の設定は[nginx-primary-origin.conf](../recovery/nginx-primary-origin.conf)。

関連Pythonテスト37件、Nodeテスト9件が成功。配置先でも構文検証が成功。

## 復元中の記録

最初の復元はINSERTごとの確定で進行が遅く、08:42:07～08:44:06 UTCに暗号文62,405,688 bytesを読み込んでいた。08:45:10 UTCに復元専用接続を`autocommit=0`へ変更して再実行。dump中のDDL/テーブルロックと最終COMMITで確定し、MySQL全体の耐久性設定は変更していない。

メインの利用可能メモリは111GiB。復元中のディスク使用率100%とcheckpointの進行を確認し、08:51:37 UTCに一時的にbuffer poolを8GiBから32GiB、redo容量を100MiBから4GiBへ拡張。その後redoを16GiBへ拡張した。復元終了時に元の値を復元する独立したsystemdジョブを配置している。異なるテーブルの取り込み速度を比較して高速化倍率とは扱わない。

## 完了確認

- 18:30 JSTまでに復元と検証が成功。40テーブル、主要9項目の件数、暗号文SHA-256が一致。管理worker用に転送した保存ファイルは260件・140,531,785 bytesで、内容ハッシュを照合し、実際の`cbte-admin`ユーザーから読み取りと親ディレクトリの書き込み権限を確認した。
- bootstrapの元の`startedAtMs=1788882087764`を保持し、復元済み通知の抑止時刻を新規作成していない。
- buffer pool 8GiB、redo容量100MiBへ復元し、実容量のresize statusも`OK`を確認。
- 権限サーバーの専用APIでOCI epoch 6からprimary epoch 7へ移譲。authority DBを直接編集していない。旧leaseは自然失効とdrainを完了していたため、authorityの再起動は不要だった。
- guardian PID `2297201`、Bot PID `2297253`。現在のPIDに一致する`ready=true`のheartbeat、`fleet_node=primary`、epoch 7を確認。
- primary instance ID: `primary:341aa72157066174074c36e544eb1736f307e57c0dca3d8f`。
- DB応答、ダッシュボード、対話worker、レポートworkerが正常。18:38:04～05 JSTの公開`cbte.sprink.cloud/api/health`と`twidata.sprink.cloud/api/health`は両方200で、node・epoch・instance IDが一致した。
- failback phaseは`PRIMARY_ACTIVE`、予約は18:38:32 JSTに`completed`。
- OCIの旧DBコンテナは停止してデータを保全。controllerを再開し、メイン稼働中の旧OCI workloadは起動させていない。
- 18:38:33 JSTに既存の`mysql-backup-push.service`で切り戻し後のバックアップを開始。18:46:42 JSTにSFTP commitとサービスのexit 0を確認。
- NASは18:50:48 JSTに新世代`20260910T093833Z`を検証済みとして受領。944,210,436 bytes、SHA-256 `4dbbba7eb2bc3c4eeba514c084ec5a0f32567db011a3e62e0ba4c8a9b9361ca4`、APIの`sha256Reverified=true`・`skipped=[]`を確認した。
- OCIはこの新しい世代の`EXPORTING`へ進み、lastErrorはなし。予備系の再暗号化・復元検証はサーバー上の常駐controllerが継続している。古いバックアップを使った予備系昇格は、新しいバックアップの取得・復元検証を終えるまで許可しない。予備系更新の完了とは区別する。

OSの再起動は行っていない。Botの接続・DB・各health応答と保存データを検証したが、全Discord操作や全レポートを網羅した負荷試験とは区別する。
