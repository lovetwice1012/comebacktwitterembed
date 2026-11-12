# Mac Chrome 署名・公証候補の作成

この手順は、管理者がMac上で未公開候補を作成するためのものです。作成しても配布設定は更新されず、利用者へ公開されません。Mac BraveやFirefoxの正式版を作る手順ではありません。実際のX通知やDiscord配送の確認にもなりません。

スクリプトを実行すると、署名済みアプリをAppleの公証サービスへ送信します。実行前に送信を承認し、既存のDeveloper ID Application証明書と、`notarytool`用のKeychain profileをMacに準備してください。パスワードやAPI鍵をコマンド引数、ログ、チャットへ記載しません。証明書やprofileの作成・変更はこのスクリプトが行いません。

## 準備

- Apple Silicon用とIntel用は、それぞれ対象アーキテクチャのMacで作成する。
- Xcodeのコマンドラインツール、Developer ID Application証明書とKeychainに登録済みの公証profileを用意する。profileはアカウントの機密値ではなく、ローカルで識別する名前を渡す。
- 既存ビルダーで固定されているNode 24.21.0の対象Mac版実行ファイルとライセンスを、絶対パスで用意する。ビルダーが両方のSHA-256を照合する。
- 出力先には、まだ存在しない `chrome-mac-<arm64またはx64>-<正式バージョン>.zip` を指定する。既存ファイルは上書きしない。

以下の `<...>` は本人の環境に合わせて指定する値です。`IDENTITY` は `Developer ID Application: ...` 形式の証明書の表示名、`PROFILE` は用意済みKeychain profile名です。これらにパスワードや秘密鍵を直接指定しません。

```sh
node scripts/build-mac-chrome-release-candidate.cjs \
  arm64 1.2.3 <TEAM_ID> '<IDENTITY>' <PROFILE> \
  /absolute/path/to/node /absolute/path/to/LICENSE \
  /absolute/path/to/chrome-mac-arm64-1.2.3.zip
```

実行前に出力先が存在すると停止します。署名、公証、ticketの添付・検証、Gatekeeper検査のいずれかに失敗した場合、候補ZIPは作られません。実行結果は候補のファイル名、サイズ、最終SHA-256と、Appleへの提出ZIPのSHA-256を表示します。提出ZIPとticket添付後の最終ZIPは別の成果物です。

補助プログラムは署名してからmanifestにハッシュを記録し、その後再署名しません。launcher、ネイティブaddon、Nodeとappをそれぞれ署名します。Nodeの署名は固定された配布元バイナリーの検証後に行います。公証が `Accepted` になった後でappにticketを添付し、最終ZIPを展開し直して署名・ticket・Gatekeeper・補助プログラムのハッシュを検証します。

## 公開前の別作業

このスクリプトは候補作成の準備であり、Developer IDによる実行・公証を含めたMac実機試験はまだ行っていません。両CPUで、ダウンロード後の隔離属性、Finderからの起動、Keychain確認、専用プロフィールの分離、ファイル作成、取得した成果物の改変拒否を検証する必要があります。署名や公証が通っても、合成FCM試験で観測された初回410やChrome更新中の署名検証競合が解決したことにはなりません。

実X通知の確認は利用者が後日行う方針です。本番公開には、それとは別に実際の成果物をレビューし、各アーキテクチャの固定版情報・配布物とサーバー設定を整合させる工程が必要です。`src/automation/x-chrome-mac-release.js` の未設定値はスクリプトでは変更しません。Appleの[公証手順](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)も参照してください。

現行の起動コードは内部manifestの識別値 `0.1.0-mac-preview.1` を固定しているため、候補ZIPの正式バージョンと別にこの識別値を維持します。書き換えると起動時に拒否されます。この内部識別の正式化は今後のリリース準備に含まれ、候補作成と混同しません。

候補は出力先と同じファイルシステム内の非共有一時ディレクトリに書き、内容を同期してから、既存の名前を置き換えない原子的なリンク作成で確定します。リンクを作れないファイルシステムでは候補を出さずに停止します。結果の `cleanupPending` が `true` の場合は候補自体の完成後に一時ファイルの除去を確認できていません。出力先ディレクトリを確認してから片付けてください。

署名・公証コマンドには限定した環境変数を渡します。外部から指定した `DEVELOPER_DIR`、SDKやコンパイラーの検索パス、動的ライブラリーの注入設定は引き継ぎません。システムのXcode選択から `notarytool` と `stapler` を解決し、実行前にApple署名を検査します。Apple署名の検査から起動までの間に、同一権限の別プロセスがツールを差し替える競合を、このスクリプト単独で完全には排除できません。信頼できるMacで実行してください。
