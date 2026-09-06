# 復元DBのトリガー実行者

DBだけを復元すると、トリガーの `DEFINER` は残る一方で `mysql.user` のアカウントは作られない。2026-09-06のOCI切り替えでは、カウント更新トリガーの実行者が存在せず、Botの分析イベントINSERTが1449で失敗した。

新しい復元は、検証済みとする前に `restore_definers.py` で次の前提を確認する。

- トリガーはリポジトリのカウンター実装と一致する17件。名前、対象テーブル、イベント、タイミング、実行者、SQL本文を照合する。
- 実行者は固定の `debian-sys-maint@localhost`。作成が必要な場合もランダムなパスワードを破棄し、`ACCOUNT LOCK` を設定する。
- 権限は8テーブルの `TRIGGER`、`bot_table_count_deltas` の `SELECT/INSERT/UPDATE`、`bot_provider_content_events` の `SELECT`、`bot_provider_content_facets` の `SELECT/DELETE` に限定する。付与後もこの14権限だけであることを再確認する。
- 未知の定義、routine・event・view、ロックされていない既存実行者、広い静的権限、動的グローバル権限、proxy権限やroleを持つ実行者があれば自動変更しない。復元候補を隔離し、原因を記録する。

トリガーの実行時には、実行者のTRIGGER権限と、OLD/NEW参照やトリガー本文で必要な権限が確認される。[MySQL 8.0公式仕様](https://dev.mysql.com/doc/refman/8.0/en/create-trigger.html)

トリガーやアカウントを作り直して件数を再設定する処理ではない。既存のカウンターbaseline・delta・全レコードは保持する。復元receiptの `checks.storedObjectDefiners` に照合件数、定義ハッシュ、作成の有無、必要権限を保存する。生成したパスワードやSQLエラー中の秘密情報は記録しない。
