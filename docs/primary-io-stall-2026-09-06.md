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

## 初期診断時点の対応

- 今回開始した保存データACL処理だけに停止要求を送信。D状態中なので、要求の完了は確認できない。
- OCIの外部監視対象を本体の `/ops/healthz` に変更。通常の連続失敗条件で障害を検出し、Discord通知のHTTP 200受付を確認。
- OCIの復元処理と起動許可サーバーを維持。本体guardianのネットワーク・tmpfs上の起動許可更新は継続している。
- 強制再起動、アンマウント、fsck、WBT・ディスクキャッシュ設定の変更は実施していない。

## 復旧判断

Linux 5.4系の `wbt_lat_usec` 変更処理は、設定反映より先にキューの停止・利用者の退出待ちを行う。今回のように待機者が残る状態では、値0への書き込み自体も停止し得る。上流5.4と5.4.291で確認しており、Ubuntu固有の全バックポート差分は未確認。

- [sysfs処理](https://raw.githubusercontent.com/gregkh/linux/v5.4.291/block/blk-sysfs.c)
- [キューへの要求と待機](https://raw.githubusercontent.com/gregkh/linux/v5.4.291/block/blk-mq.c)
- [WBTの制御処理](https://raw.githubusercontent.com/gregkh/linux/v5.4.291/block/blk-wbt.c)

通常のサービス操作も応答しないため、自然に書き込みが再開しなければカーネル／VM側の復旧操作が必要と判断した。最新バックアップの復元検証を済ませて管理者から強制再起動の承認を得た。以降の実施状況は次節と [配備記録](admin-recovery-deployment-2026-09-06.md) に記載する。

## 承認後の操作

管理者から強制再起動の承認を受け、最新待機DBのVALIDATED状態と自動昇格無効を再確認した後、2026-09-06 15:05 JST頃に既存のroot SSH接続からSysRqによる再起動を要求した。直前のboot IDは `a3050b99-0c1e-4ce7-8fe4-8950f0aeb9d1`。その後、既存接続が切れ、旧guardianの許可更新が停止して期限切れとなった。

接続の切断だけでOSの正常起動完了とは判定していない。15:29 JSTの時点でCloudflare・OCIへの専用管理リンク・NASからのバックアップ用Tailscale経路がいずれも応答せず、VMの電源状態・起動コンソールの確認を管理者へ依頼した。NAS上では対象peerがofflineで、直接の到達試験も応答しなかった。

OCI側に残った旧SSH転送セッションは、旧起動許可の失効後に専用アカウントの該当sshdだけを終了した。再起動時に旧転送ポートが残り続けないよう、本体・NAS専用のsshd設定へClientAliveInterval 15 / ClientAliveCountMax 3を追加。NASの専用トンネルは再接続とHTTP 200を確認した。一般アカウントや既存バックアップ受信口の設定は変更していない。

15:45 JSTにOCIで緊急稼働を開始した。管理者から本体を起動したとの申告があるが、16:02 JST時点でも本体のCloudflare SSHとOCIへの専用管理ポートは戻っていない。VMの電源投入とOS・管理回線・ディスク書き込みの復旧は区別し、新しい本体boot IDを確認できるまでは復旧完了と扱わない。現在の権限はOCIが保持し、本体が後から起動しても旧DBでBotを再開できない。

## VM管理画面での追加確認

本体で観測したIPv6のインターフェース識別子に対応するMAC `8E:30:0D:8E:0E:D1` が、管理者が開いていたProxmoxのVM 100のnet0と一致した。VM 100は22GiB RAM、1650Gの `data:vm-100-disk-1` を持つ。

16:19 JSTのUI確認では、16:13:23–16:13:26にproxmox5からproxmox6への移動成功、その後16:13:31のStartが未完了だった。16:17:00の別のStartは `can't lock file '/var/lock/qemu-server/lock-100.conf' - got timeout` で失敗している。起動要求の受付だけではOSが起動したとは判断できない。Codexは構成と操作履歴を読み取っただけで、これらの移動・起動・停止・CPU設定変更を行っていない。管理者側の操作が進行中のため、電源操作やロックファイルの削除を重ねていない。
