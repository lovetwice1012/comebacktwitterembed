# 新Xセットアップ PowerShell配布版

**履歴資料（preview.1）。** 以下は抽出機能追加前の配布物と受入の記録であり、現在の操作手順ではない。
現行の `0.1.0-preview.4` は [ファイル作成クライアント](powershell-file-client.md) と
[Webダウンロード](x-setup-download.md) を参照する。現在の入口は「ダブルクリックで開始.cmd」。
旧ZIPと当時の検証証拠は履歴として保持する。

2026-10-14 JST。新方式の専用Firefox準備用、バージョン `0.1.0-preview.1`。
一般提供済みの移譲クライアントではなく、実装済みの準備操作を配布する開発プレビュー。

## 配布・再生成

```powershell
npm run build:angelic-setup
# 既存ZIPは上書きしない。再生成する場合は新しい出力先を明示:
node scripts/build-angelic-setup-package.cjs --output C:\review\new-setup-preview.zip
npm run test:angelic-setup
```

標準出力先は `artifacts/angelic-setup/angelic-setup-powershell-0.1.0-preview.1.zip` と
その `.sha256`。生成物はGit管理対象外、ソースと生成コードを管理する。
ZIPには明示した `Start-AngelicSetup.ps1`、`README-ja.md`、元の `LICENSE`、生成manifestだけを含める。
profile、Cookie、鍵、`.env`、node_modules、既存CLI、PoCの合成秘密を含めない。
同じ入力から同一ZIPを生成し、出力先やsidecarが存在すれば保存を拒否する。

配布先はWindows PowerShell 5.1/PowerShell 7。利用者はNode/Rust/npmや管理者権限を必要としない。
スクリプト本体はUTF-8 BOM付きで、Windows PowerShellでも日本語ソースを解釈できる。

## 操作と境界

- `Status`: 所有メタデータだけから準備状態・対応範囲をJSON表示する。未準備ならprepared=false。
- `Prepare`: 新しいローカル専用root/profileと所有マーカーを作る。既存非所有フォルダーを流用せず、
  ACLを本人/SYSTEMへ限定する。既存所有マーカー・ACLを上書きしない。
- `OpenFirefox`: 明示したFirefox.exeまたは固定Program Files候補で専用profileを開く。
  Xログイン・通知設定は利用者が手動操作する。スクリプトでログイン・X操作をしない。
- `-WhatIf`: 対応する変更操作を実行せず予定表示。プロファイル作成・プロセス起動なし。
- `Export` / `Transfer`: 実購読抽出/移譲が未提供のため、それぞれ終了5/6で理由表示。
  実データをsynthetic扱いして既存PoCへ通す操作や架空のアップロードは追加しない。

root、profile、exe、manifestのパスは祖先を含めreparsepointを拒否する。既知のlaunchメタデータの
PIDと開始時刻を合わせ、PID再利用による誤判定を避ける。Windowsの `parent.lock` は正常終了後も
残るため、削除や内容読取りをせず、共有禁止ハンドルを取得できるかで非占有/占有を確認する。
取得不能は安全側に停止する。一般のFirefoxプロファイル・Cookie/password/history DBを走査しない。
FirefoxのWindowsロック動作の根拠は [MozillaのnsProfileLock実装](https://github.com/mozilla-firefox/firefox/blob/main/toolkit/profile/nsProfileLock.cpp#L464-L505)。

配布の信頼境界は「信頼できる別経路のZIP SHA256照合→実行→manifest全ファイル検証→操作」。
manifestは署名の代わりにならない。ZIP内のスクリプトそのものが監査可能なソースである。
実行ポリシーを永続変更せず、READMEに必要時のプロセス単位の起動例を示す。

## 検証

`scripts/test/angelic-setup-package.test.js` は生成ZIPのallowlist/再現性/hash、上書き拒否、
不正source/output、両PowerShellでのStatus/Prepare/WhatIf/所有拒否/改変拒否と、オフラインGUI exeによる
実ProcessStart・引数の一致・二重起動拒否・stale/active lockを検証する。実Firefox/Xを起動する試験ではない。
最終のJUnitとソース・ZIPのSHA256は同ディレクトリの `powershell-distribution-tests.xml` と
`powershell-distribution-validation.json` に保存する。

最終結果: 自動試験9件成功、失敗・スキップ・TODO 0（24.0秒）。両engineの実プロセス/実ロックfixtureを含む。
標準 `Expand-Archive` で完成ZIPを展開し、Windows PowerShell 5.1のStatus、PowerShell 7のPrepare -WhatIfも成功。
ESLintは新規builder/testファイルで警告・エラー0。完成ZIPは22,867 bytes、SHA256は
`45acafe19bea7bae3451801a9daae47d6efbc53d1e26b395bbd9fec0c173040c`。

Windows PowerShellのsecurity module自動読み込みが混在する親環境で失敗する差を実試験で検出し、
ACL操作を各.NET runtimeの直接APIへ変更して解消した。起動中のfixtureが出力pipeを継承する
テスト捕捉の問題は、fixture側の出力先を通常ファイルにすることで検証した。製品にテスト専用分岐はない。

本物のFirefox Push DBはGeckoのstructured-clone等を含み、単純なSQLite→JSON変換で保証できない。
既存のWeb公開APIから秘密鍵を取り出せるとも仮定しない。指定版・専用profileで安全抽出、同UAIDでの
実通知受信復号、運用条件のG1を実証してから、実extract/owner-bound HTTPS移譲を別途実装・受入する。
既存の `firefox-source-investigation.md` と `implementation-status.md` の未達事項は変わらない。
本番データ変更・決済有効化・受信サービス提供・公開配信は行っていない。
