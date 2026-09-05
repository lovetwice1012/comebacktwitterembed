# 正確な統計件数の差分管理

大規模な8表の行数は、InnoDBトリガーによる差分と初期値の合計で求める。テーブル一覧は `src/table-count-tables.json` を共用する。小さい設定表の件数は従来通り取得する。

- AFTER INSERT: 実際に新規作成された行だけ +1。
- AFTER DELETE: 実際に削除された行だけ -1。
- UPSERTの更新、INSERT IGNOREで無視された行、UPDATEは行数を変えない。
- データと差分は同じトランザクションで確定・ロールバックされる。
- 書き込み先を16行に分散する。個々の差分は負数を許容し、合計で正確な件数を表す。
- ファセットの親にはBEFORE DELETEで子を明示削除するトリガーを設ける。これにより、外部キーの連鎖削除では実行されない子のDELETEトリガーを確実に実行する。

初期集計は、同じREPEATABLE READの読み取り専用スナップショットで全件数Nと差分Dを取得し、基準値B=N-Dを保存する。以後の件数はB+現在の差分合計。同時書き込みがあっても、スナップショット後の差分を上書きしない。インストールや初期集計の再実行で既存差分を消去しない。

## インストールと検証

DB側の変更は明示的な保守コマンドで実施する。Bot起動時には小さな管理表だけが作成され、トリガー作成や全件集計は実行されない。各コマンドはDB名を必須とし、トリガー操作には適切な管理権限が必要。

```sh
node scripts/manage_table_counts.js install --database ComebackTwitterEmbed --defaults-file /etc/mysql/debian.cnf
node scripts/manage_table_counts.js seed --database ComebackTwitterEmbed --defaults-file /etc/mysql/debian.cnf
node scripts/manage_table_counts.js verify --database ComebackTwitterEmbed --defaults-file /etc/mysql/debian.cnf
node scripts/manage_table_counts.js status --database ComebackTwitterEmbed --defaults-file /etc/mysql/debian.cnf
```

`--table`で対象を1表に限定できる。初期集計は1表ずつ実行し、既定のSQL上限は15分。`--timeout-ms`で最大30分まで指定できる。`seed --reseed`は、差分を消さずに整合した基準値を再取得する。トリガー欠落・未知の連鎖削除・定義不一致は処理を中断する。

独立したMySQL検証DBでの統合テスト:

```sh
node scripts/test_mysql_table_counts.js --defaults-file /etc/mysql/debian.cnf
```

このテストは専用名の空DBを作成し、実際の8表のDDLで、移行途中の別接続からの書き込み、UPSERT、重複無視、削除、連鎖削除、ロールバック、再初期化と全件照合を確認する。最後に自分が作成した検証DBだけを削除する。

## ダッシュボードの更新

概要は件数管理表を1回読み、大規模表への全件COUNTを行わない。未初期化・不整合・未対応バージョンの件数を0や推定値として返さない。

概要と重いレポートは別の構築枠を使う。全体のSQL同時実行数は最大4、重いレポートは最大3で概要の処理余地を残す。SELECTにはDB側のMAX_EXECUTION_TIMEを付与し、WITH句は外側のSELECTに付ける。既定のSQL上限は60秒、レポート全体の新規クエリ発行予算は180秒。`DASHBOARD_REPORT_QUERY_TIMEOUT_MS`でSQL上限を変更可能。

SQLが失敗したレポートは、内部で空配列などに変換されても正常なスナップショットとして採用しない。発行済みSQLの終了を待ってから構築枠を解放する。最終成功データと更新日時を保持し、失敗理由と再試行を表示する。初回未生成時は生成中またはエラーを表示し、0件の統計に見せない。概要も既存のスナップショット保存表へ保存する。

旧版がSQL失敗後の代替値を保存している可能性があるため、正常完了を保証する今回のレポートには新しい保存キーを使用する。新しい形式で成功したスナップショット以降を再利用する。

関心分析ではサーバーごとの繰り返しを結合前にまとめ、共通サーバー数は上位100組を確定してから計算する。重み付き件数・ユーザー数・サーバー数を維持したまま中間行数を減らす。プロファイルは5秒以上のSQLを自動記録し、`DASHBOARD_REPORT_PROFILE=1`で全クエリを計測できる。記録対象はSQLの先頭と所要時間で、バインドパラメーターは記録しない。

サーバー上で `node scripts/check_admin_reports.js overview` または `advanced` を実行すると、同じレポート生成処理を使って計測・保存できる。Web認証を省略するエンドポイントは追加しない。本番ビルド時のワーカー数は2に制限する。

## 保守上の注意

- TRUNCATE、DROP、外部キー検査を無効化した直接操作はトリガーによる計数の対象外。通常の削除はDELETEを使用する。表を作り直した場合はinstallとseedを実行し、verify成功後に利用を再開する。
- 親子両方を同時に対象とするmulti-table DELETEは使用せず、親のDELETEまたは子のDELETEを実行する。
- 新たなCASCADE経路やトリガー変更を導入する場合は検証DBで再確認する。
- 定期検算は通常の統計生成キューへ入れず、低負荷時間に1表ずつ行う。verifyで差異を検出した表はreadyを解除し、再初期化まで新しい不正な件数を表示しない。
- 機能を撤回する際は読み取り側を旧リリースへ戻せる。差分管理表を先に削除するとBotの書き込みが失敗するため、削除が必要な場合は計数トリガーを先に除去し、その後に管理表を扱う。
