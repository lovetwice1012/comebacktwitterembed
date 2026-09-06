# 本体の書き込み停止の観測

2026-09-06 13:46 JST以降。本体の通常Webは応答する一方、OS・Bot・管理デーモンのディスク書き込みが進まない状態を確認した。

## 確認できた状態

- 仮想ディスクはQEMU HARDDISK。ルートファイルシステムはext4/LVM。
- PID 1はディレクトリ作成のロック待ち。journald、Bot、管理コアの残存スレッドがext4ジャーナルの書き込み待ち。
- jbd2は `jbd2_journal_commit_transaction → __wait_on_buffer`。
- 書き戻しworkerと別サービスのスタックは `rq_qos_wait → wbt_wait → __rq_qos_throttle`。
- 複数回の測定で物理側sdaの書き込み完了数が増えず、inflightは0。sda3は96、dm-0は135が残った。読み取りは少量進んだ。
- WBTのinflightは96、通常枠48・背景枠24、遅延目標75ms。device-mapperはsuspendされていない。
- 管理コアは終了したメインスレッドとD状態の書き込みスレッドが残った。cgroupのOOM発生0、failcnt 0、最大使用量約235MB。384MiBの上限到達は観測していない。
- 同種の待機スタックは前日のカーネルログにも存在した。

OS内の書き込み制御経路で待機を確認した。具体的なカーネル不具合やVMホスト側の原因の特定は未完了。

## 実施した対応

- 今回開始した保存データACL処理だけに停止要求を送信。D状態中なので、要求の完了は確認できない。
- OCIの外部監視対象を本体の `/ops/healthz` に変更。通常の連続失敗条件で障害を検出し、Discord通知のHTTP 200受付を確認。
- OCIの復元処理と起動許可サーバーを維持。本体guardianのネットワーク・tmpfs上の起動許可更新は継続している。
- 強制再起動、アンマウント、fsck、WBT・ディスクキャッシュ設定の変更は実施していない。

## 復旧判断

Linux 5.4系の `wbt_lat_usec` 変更処理は、設定反映より先にキューの停止・利用者の退出待ちを行う。今回のように待機者が残る状態では、値0への書き込み自体も停止し得る。上流5.4と5.4.291で確認しており、Ubuntu固有の全バックポート差分は未確認。

- [sysfs処理](https://raw.githubusercontent.com/gregkh/linux/v5.4.291/block/blk-sysfs.c)
- [キューへの要求と待機](https://raw.githubusercontent.com/gregkh/linux/v5.4.291/block/blk-mq.c)
- [WBTの制御処理](https://raw.githubusercontent.com/gregkh/linux/v5.4.291/block/blk-wbt.c)

通常のサービス操作も応答しないため、自然に書き込みが再開しなければカーネル／VM側の復旧操作が必要。強制再起動は未保存データを失う可能性があるため、最新バックアップの復元検証を済ませてから管理者の承認を得て実施する。本体再起動後は、ディスク書き込み・guardianの再登録・BotのGateway接続・管理APIを再確認し、その後に自動切り替えを有効化する。
