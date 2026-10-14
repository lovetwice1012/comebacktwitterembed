# Windows Node 起動異常の原因と修正

2026-10-14 JST。対象は既存の JUnit に残った子プロセス終了コード
`3221226505`（`0xC0000409`）。成功した再実行だけでは解決としない。

## 特定した原因

公式署名・配布ハッシュが一致する Node **24.15.0 / libuv 1.51.0** の
Windows用TCP接続処理で、スタック保護チェックが失敗している。
アプリ依存なしの import graph と loopback HTTP テストでも同じ終了を再現した。
Application Error / WER と JavaScript の例外ログには記録がなかった。

今回だけの子プロセス群に適用した Windows Debug API の採取で、
例外コード `0xC0000409`、パラメーター **2**（stack cookie check failure）を確認した。
公式の24.15.0 PDBに照合した例外位置は `__report_gsfailure+0x1d`。
保存スタックには `uv__tcp_connect+0x3af`、`uv_tcp_connect+0x3b`、
`node::TCPWrap::Connect<sockaddr_in>+0x248` がある。
生スタックのシンボル候補であることを含む出力を `node-startup-native-analysis.txt` に保持した。
今回のダンプは合成fixtureの診断用で、配布物・リポジトリには含めずprivate Tempへ保持する。

旧版の `uv__is_fast_loopback_fail_supported()` は `OSVERSIONINFOW` のサイズを
初期化せず `RtlGetVersion()` に渡していた。これは不定動作とスタック破損を起こす既知の不具合で、
Node側の [修正 #62561](https://github.com/nodejs/node/pull/62561)、
[同じTCP障害 #63620](https://github.com/nodejs/node/issues/63620) と一致する。
[24.15.0の該当ソース](https://github.com/nodejs/node/blob/v24.15.0/deps/uv/src/win/tcp.c#L697-L709) と
[修正版24.21.0](https://github.com/nodejs/node/blob/v24.21.0/deps/uv/src/win/tcp.c) を比較した。
同じ終了コードだけを根拠にMaglevや暗号処理の問題と断定せず、採取した例外とTCP経路で判定した。

## 修正

- プロジェクトと移植パッケージの `.node-version` を **24.21.0** に更新。
  移植パッケージのengine・npm版も固定版と一致させる。Rust比較基準は変更しない。
- `scripts/setup-project-node.ps1` は保守担当者向け。公式固定ZIPとnode.exeのSHA-256、
  OpenJS署名を確認して利用者のローカルキャッシュへ配置する。既存のNode・PATH・レジストリを変更しない。
- `scripts/run-project-node.cjs` はWindowsでは検証済みの固定版を起動する。
  キャッシュ欠落・改変・リンクは明示エラーにし、自動リトライやJIT無効化で隠さない。
  Windows以外は既存の `process.execPath` を使う。
- 主要なWindows検証入口を固定ランタイムへ接続し、Botには `npm run start:windows` を追加。
  既存の `npm start` / `node index.js` もWindowsではアプリ依存の読み込み前に固定版へ引き継ぐ。
  固定版の子は同じ入口で通常起動し、Linuxの入口・PID・argv・require.mainは維持する。
  Bunの禁止も維持する。旧Windows版をruntime guardだけの経路で使う場合も、
  ネットワーク処理前に説明して止める。

```powershell
# 保守担当者だけが実行。Firefoxの保存ツールを使う一般利用者には不要。
.\scripts\setup-project-node.ps1
node .\scripts\run-project-node.cjs -p process.version
npm run start:windows
npm run test:x-notification-history
```

CJS起動器を古い `node` / `npm` で実行する際の最初の短いプロセス自体は旧版である。
最初から固定版を使う必要がある保守環境では、セットアップ結果の `executable` を直接実行する。
本番へのNode更新・サービス再起動・デプロイは今回実施していない。

## 証拠の区別

- `node-startup-24.15-local-native-001.tap`〜`004.tap`: 依存なしの旧版で再現した子のnative終了。
- `project-node-runtime-tests.xml`: 起動器と両PowerShell版セットアップの検証。
- `node-24-21-phase0-tests.xml`: 最初の比較試験。cwd依存のCLI fixtureと、過負荷時の
  Rust未送信を古い受信行と比較するfixtureの問題を検出した記録。
- 古い49/50枠などのSQL試験、120回の最小起動・35回の単独SQL成功は、原因特定の代わりにはしない。

診断用の大量接続ではWindowsの一時ポートを消費し、別途 `EADDRINUSE` による通常の
fetch/DB接続失敗も発生した。これは今回のnative終了と区別して記録し、過負荷状態の試験を
成功と数えない。最終検証は負荷を止めてポート回復後に実施する。

回復後、同一の依存なしfixtureを各版1,000回、各2workerで比較した。
**24.15.0は998成功・同じnative異常2件、24.21.0は1,000成功・異常0件。**
通常のfetch失敗・EADDRINUSE・タイムアウトはいずれも0件。
各回の記録・失敗TAP・入力hash・終了集計は `node-startup-clean-ab/comparison.json` にまとめた。
固定版でのRust差分を含むPhase0全199件も `node-24-21-phase0-final-tests.xml` で成功した。

最終のローカル回帰は `mixed-notification-acceptance-tests.xml` の623件、実Gecko合成fixtureは
`mixed-notification-native-tests.xml` の6件、Web実ブラウザーは11チェックが成功。
通常起動入口のVM境界と引継ぎは `windows-node-bootstrap-tests.xml`、最終対象hashは
`mixed-notification-validation.json` に記録する。実Discord接続や本番起動を実行した記録ではない。
