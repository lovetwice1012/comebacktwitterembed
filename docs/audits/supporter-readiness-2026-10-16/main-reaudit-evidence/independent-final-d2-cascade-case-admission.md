# 追加10件：cascade・UUID・接続admission修正後の独立承認

固定source `d2e792d30a44723e603869b27970b05597d51a9d` の判定は **CLEAN**。変更32ファイルをcanonical Gitのmode/blob/bytes/hashと作業ファイルで照合し、CORE8と本番基準c630からのschema69パスのraw bytes・mode不変を確認しました。新DDLはありません。

現在sourceで独立59件成功（うち19件はsocket-free helper unit）、失敗・skip・cancel・todoは0です。旧helper9d28限定variantではUUID caseの2件が期待通り失敗し、新sourceでは同じ実SQL制御が2件成功しました。copy/revokeは同一CI UUIDで待機し、copy後の導入先変更は409になります。mixed-case run参照もnamespace lockを保持し、保存ID・plan JSONは変えません。

旧legacy SQL・CASの51件、102子の後半ページで投影後に失敗させる完全rollbackを含む4件、独立したcancel先行／claim先行の両順序2件を確認しました。全直接子とrun summaryは同じtransactionで反映し、確認済みACK・sent/unknown子・future dueを保持します。旧legacy assertion c142とCAS e017は変更していません。

接続admissionの再試行はtest helperのSQL前に限定され、SQL・commit・assertionは再実行しません。旧47219は不合格のまま保存し、Windowsの具体的121対10060の原因は未特定と記録します。この59件を新root185ファイル全体の成功へ合算しません。全体受入・main・実bundle・本番・実OAuth／通知／決済は別判定です。

自身schemaは0件、残る開始前のunknown7件は未操作です。全source hashと証跡hashは同名JSONを参照してください。
