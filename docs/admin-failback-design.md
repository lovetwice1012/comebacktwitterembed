# OCI から本体への切り戻し設計

2026-09-06。現行コードの読み取りに基づく設計。切り戻し機能はまだ実装・本番検証されていない。この文書の作成ではサービス、DB、起動許可、公開経路を変更していない。

## 現在、本体の起動だけでは戻らない理由

現在の復旧基盤は本体から OCI への一方向である。OCI が正本になった後、本体の OS が起動しても、本体 guardian は起動許可を取得できず Bot を待機させる。これは二重処理と OCI 稼働後の更新消失を防ぐが、復帰まで自動化したい運用を満たすには追加実装が必要である。

| 現行コード | 実際の制約 |
| --- | --- |
| `recovery/authority.py` の `promote()` | `target != "oci"` を `FAILBACK_FORBIDDEN` として拒否する。本体へ所有権を戻す API はない |
| `recovery/controller.py` の `tick()` | `activeNode == "oci"` では既存の OCI DB と workload を維持し、本体へのデータ転送・役割変更は行わない |
| `recovery/routing.py` の `ensure_routes()` | OCI の node・epoch・instanceId と固定 tunnel を検証する一方向処理。本体の tunnel へ戻す機能はない |
| `recovery/start_workload.py` の `active_container_command()` | MySQL は `--skip-log-bin`。現在までの OCI 更新を既存 binlog から差分転送することはできない |
| `recovery/active_backup.py` の `create()` | 有効な OCI lease が必要。Bot 停止・lease 返却後の最終転送に、そのまま流用できない |
| `src/recoveryBootstrap.js` の `configuration()` | 隔離状態の利用を `CBTE_FLEET_NODE=oci` に限定する。本体への継承に対応していない |

`docs/admin-disaster-recovery.md` にも「本体への自動的な切り戻しはしない」と記載されている。単に設定を一つ有効にすれば戻せる状態ではない。authority の SQLite を直接編集したり、DNS だけを本体へ戻したりして解決しない。

## 維持する条件

1. Bot・設定変更・通知・保存処理など、利用者データを変更する実行主体は同時に一方だけに置く。
2. OCI 稼働後の DB 更新を転送し、最終同期後から本体起動まで OCI の書き込みを禁止する。
3. 本体の旧 DB と保存データを保全する。旧 DB には採用バックアップ以降、障害前までの更新がある可能性がある。OCI DB との自動マージや旧 DB の破棄はしない。
4. authority の epoch は単調増加させる。旧 epoch や失効済み lease を復活させない。
5. 本体の新しい Bot PID・bootId・epoch・instanceId、Gateway ready、DB、公開経路を確認して完了とする。SSH や HTTP 200 だけでは完了にしない。
6. 停止・保守の運転指示、重複防止の受付記録、復旧時の通知隔離を移動中も維持する。
7. 転送・インポート途中の失敗では、検証できていない本体 DB から起動しない。元の OCI DB を保全する。

現在の OCI 正本を本体へ移すのが基本方針である。本体の旧 DB と OCI の両方に存在する固有更新は別途差分を調査し、衝突する設定・受付結果を黙って選択しない。旧 DB の保全を、差分統合済みという意味で表示しない。

## 最小実装と進行状態

最初の実装は、書き込み停止を伴う整合性優先の全量転送とする。現在の MySQL 構成では、稼働中の全量コピー一回だけで更新の取りこぼしを防ぐことはできない。実際のデータ量・本体 I/O・回線速度に応じた停止時間が必要であり、短時間や無停止を約束しない。

| 状態 | 処理と完了条件 | この時点の書き込み元 |
| --- | --- | --- |
| `OCI_ACTIVE` | 通常の緊急稼働。切り戻し要求を一つの operation ID で永続化 | OCI |
| `PRIMARY_CHECKING` | 新 bootId、SSH、DB 版、空き容量、実ファイルの作成・fsync・読み戻し、管理 agent、guardian 導入証明、到達経路を確認。限定した検査に期限を設ける | OCI |
| `PRIMARY_PREPARING` | 本体旧 DB と設定を保全。別 DB インスタンスまたは別の候補領域、同じアプリ版・秘密設定・認証方式・公開 tunnel を準備。本体の Bot・worker は待機 | OCI |
| `SOURCE_QUIESCING` | OCI の運転指示を切り戻し用保守状態に CAS 更新。新しい変更操作を受け付けず、既存操作の完了または結果不明を記録。Bot・Next の変更 API・分析 worker・通知・保存などの全 writer を停止 | 停止に移行 |
| `SOURCE_FROZEN` | OCI の対象 DB を `super_read_only=ON`、event scheduler を OFF にし、実際の接続・未完了 transaction・プロセス群を確認。guardian の停止と旧 lease の失効・drain を確認 | なし |
| `FINAL_COPYING` | 読み取り専用 OCI DB から最終 dump を暗号化転送し、本体の隔離候補へ復元。各段の終了、ハッシュ、サイズ、DB 検証結果、ファイル差分を記録 | なし |
| `PRIMARY_PREPARED` | 最終コピー、移行する管理受付・通知隔離・ファイル状態、設定を固定した manifest と checksum で束ねる。公開 Bot を起動しない検証を完了 | なし |
| `OWNERSHIP_COMMITTING` | controller が専用の切り戻し API を呼ぶ。operation ID・OCI の現 epoch・対象本体・manifest を照合し、旧 lease の有効期間と drain を待って epoch を増やし本体へ移す | なし |
| `PRIMARY_STARTING` | 本体 guardian が新 epoch の lease を取得し、指定済み候補 DB を使って Bot・worker を起動。起動時の migration や通知も書き込みとして扱う | 本体 |
| `PRIMARY_VERIFYING` | 今回の PID・bootId に一致する Gateway ready、DB 応答、必要な endpoint、継承した隔離状態を検証 | 本体 |
| `ROUTING_PRIMARY` | 許可済みの二つの公開 hostname だけを本体 tunnel に設定。各 URL の node・epoch・instanceId が新しい本体と一致するまで再照合 | 本体 |
| `PRIMARY_ACTIVE` | OCI DB と移行前本体 DB を保持したまま切り戻し完了。日次バックアップ、OCI の次回待機候補、通知、運転指示を整える | 本体 |

本体が到達不能、書き込み検査失敗、容量不足、旧データの保全不能であれば `PRIMARY_CHECKING` / `PRIMARY_PREPARING` のまま理由を表示し、OCI を継続する。停止を伴う段階へ先に進めない。

全量転送の事前リハーサルや容量見積もりは OCI 稼働中にできる。ただし、その時点のコピーを最終コピーと扱わない。将来、稼働中コピーと差分追従を実装する場合は binlog の有効化、開始点、保持期間、再接続、追従確認を別途設計・検証する。

## 起動許可と controller の変更

- 既存の OCI 自動昇格 API を汎用の自由な役割変更 API に広げない。切り戻しには、永続化された一つの計画に対応する専用操作を追加する。
- 計画には `operationId`, `sourceNode`, `sourceEpoch`, `sourceInstanceId`, `targetNode`, `targetBootId`, `targetInstallationId`, `manifestSha256`, 両側の運転指示 revision、作成者、各段階の証拠を保存する。秘密値は含めない。
- authority は controller 権限、同じ要求の冪等性、現役割、epoch、本体の有効な導入証明、隔離期間、旧 lease の失効と drain を検証する。元 API と同様、通信応答を失った場合は同じ operation ID で照合する。
- データ同期やプロセス停止の証拠は固定ホスト上の限定した helper が作成する。API 呼び出し元が任意の `ready=true` を送るだけで切り戻せる設計にしない。
- controller は切り戻し中の OCI 自動再起動・DNS の OCI 向け再設定・旧バックアップ再復元を行わない。状態はプロセス再起動後にも残す。
- authority の更新時に発生する既存の隔離期間も考慮する。OCI が通常稼働中に authority を不用意に再起動せず、計画した停止段階とまとめる。
- 切り戻し後は古い OCI 候補を直ちに次の自動昇格対象に戻さない。本体の新しい正本から作った検証済み候補へ更新してから待機を整える。候補が古いままである状態を明示する。

復帰まで完全自動にする場合は、この状態機械を同じ条件で進める自動ポリシーを追加する。本体の一定期間の健全性、容量・同期の実測、停止時間の予算、連続切り替えを防ぐ待機期間を条件とし、失敗時には OCI を継続する。今回の切り戻し操作の認可と、将来の自動実行ポリシーの設定値を混同しない。

## DB 以外で移す状態

| 対象 | 切り戻し時の扱い |
| --- | --- |
| OCI の新しい保存メディア | サイズ・件数を調べ、本体の既存 `saves` を残して安全に追加。同じ userId/tweetId の衝突では両方を保全して解決する。ユーザーが許容した「古い savedata を OCI に持ち込めない」という制約を、OCI 稼働中に作られたデータを捨てる許可と解釈しない |
| 保存 lock・journal・staging | 全 writer 停止後に未完了状態を調査。旧 PID を生存判定に使用せず、絶対パスを検証して再配置。既存本体のファイルを一括上書き・削除しない |
| `bootstrap/` と通知の隔離記録 | 復旧元 candidate と最初の `startedAtMs` を保存し、実行 node と切り離して本体でも利用できるよう修正。新しい時刻で再初期化して OCI で登録された正常な通知まで除外しない |
| BOOTH JSON・通知済み状態 | DB dump に含まれない。OCI の実際の状態を取得し、旧本体の未送信状態を再開して重複通知しない。自動マージ不能な衝突は保全・表示する |
| Go SQLite / worker receipt | 稼働中 SQLite の主ファイルだけをコピーしない。online backup または停止・checkpoint を使う。OCI と本体の履歴をホスト付きで保存し、同じ操作キーを新規操作として再実行しない。未完了の変更操作を隔離する |
| 認証・policy・outbox | 本体と緊急管理の origin、既存 passkey、許可 ID を維持。OCI の SQLite で本体の認証情報を丸ごと上書きしない。通知 outbox の再送条件を確認する |
| provider override・spool・統計 JSON | 有効期限、元の観測期間、未転送証拠を維持。双方のカウンターを無条件に足したり、OCI の欠測期間をゼロとして扱ったりしない |
| 短期ダウンロード | 残存 TTL と容量に基づき継続または失効を明示。旧一時 PID・socket・journal cursor を現役として復元しない |

現行 bootstrap は DB の通知レコードを変更せず、ファイルと実行時条件によって抑止している。そのまま通常本体へ DB だけを戻すと抑止が外れるため、隔離の継承は本体起動より前に必要である。

## 中断、取消、復旧

- **OCI の書き込み停止前**: 任意の失敗や取消では OCI を継続し、未採用の本体候補を隔離する。
- **停止後・所有権変更前**: 本体が一度も書いておらず source の固定内容が維持されていることを確認し、同じ OCI 正本の再開を選べる。運転指示と lease の再取得を照合し、古い lease を再利用しない。
- **所有権変更後・本体起動前**: 「起動しなかった」証拠があっても authority の epoch を巻き戻さない。逆方向の引き継ぎ操作を記録し、必要な drain 後に新しい epoch で OCI に戻す。
- **本体起動後**: migration、設定変更、通知済み更新を含め、新しい書き込みがあり得る。OCI の凍結済み DB をそのまま起動してはならない。本体から最終差分または全量を戻す別の引き継ぎを行う。書き込みの有無が不明なら、無かったものと扱わない。
- **DNS の一部だけ変更された場合**: 所有権と DB を維持したまま同じ hostname・同じ tunnel の結果を再照合する。DNS の失敗だけで Bot の所有権を往復させない。
- **途中で controller が停止した場合**: 保存済み計画、authority の現 epoch、各候補、プロセス群、両側の DB 読み取り専用状態を再取得して段階を照合する。単に前のコマンドを再実行しない。

取消要求は受け付け時点の状態と照合する。所有権変更後の取消は安全な復旧計画として処理し、即時の DNS 切り替えや DB の上書きには変換しない。

## 必要な検証

- authority: OCI lease 有効中、drain 中、古い epoch、別 operation ID、変更された manifest、未導入の本体を拒否。同じ要求・応答消失・再起動後の再照合で epoch が一度だけ増える。
- 排他: 本体の OS 復帰、旧 guardian の再接続、OCI 再起動、ネットワーク分断、controller の再起動が重なっても、両 Bot が有効 lease を持たない。
- コピー: OCI 稼働中・停止直前の設定更新を含む。転送切断、容量不足、復元途中終了、ハッシュ不一致では候補を採用しない。本体の旧 DB は残る。
- 管理操作: 受付済み送信の応答が消えた直後に切り替えても再送しない。復旧前の queued/running を実行可能な新規操作に変換しない。
- 通知: 復旧前の保留レコードは本体でも抑止し、OCI 稼働中に登録した正常な通知は継続する。DB とファイルの双方を対象にする。
- 保存: 本体の既存ファイルと OCI 新規保存の衝突、未完了 journal、旧 PID の再利用、公開 URL、ACL、容量表示を確認する。
- 起動・公開: 別 PID の古い ready 記録、古い epoch の HTTP 200、片方の hostname だけ成功、Cloudflare 応答消失を完了としない。
- 取消・復旧: 各状態で終了させて再開し、本体が書き込みを始めた後の OCI 再開には逆同期が必要であることを確認する。
- 本体の I/O 障害再発: 書き込み検査と限定した監視で停止段階に進まない。検査そのものの待ちが OCI の lease 更新を妨げない。

完了の証拠には operation ID、両ホストの bootId、移行 manifest、最終同期時刻、authority の新 epoch、現在の Bot PID、Gateway ready、二つの公開 URL、保全した旧データの所在、未解決の差分を残す。
