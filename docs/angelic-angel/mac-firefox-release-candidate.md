# Mac Firefox の配布候補

この手順は、Mac 上で未公開の Firefox 用候補を作るためのものです。候補の作成ではアプリを Apple の公証サービスへ送信します。実行には、事前に用意した Developer ID Application 証明書と `notarytool` の Keychain profile が必要です。パスワードや秘密鍵をコマンド引数やチャットに記載しません。

Apple Silicon と Intel のそれぞれで、固定済み Node 24.21.0 の対象アーキテクチャの実行ファイルと LICENSE を用意します。出力先には存在しないファイルを指定します。

```sh
node scripts/build-mac-firefox-release-candidate.cjs \
  arm64 1.2.3 <TEAM_ID> '<IDENTITY>' <PROFILE> \
  /absolute/path/to/node /absolute/path/to/LICENSE \
  /absolute/path/to/firefox-mac-arm64-1.2.3.zip
```

`IDENTITY` は `Developer ID Application: ...` 形式の証明書名、`PROFILE` は既存 Keychain profile の名前です。Intel 用は `arm64` を `x64` に変更します。スクリプトは証明書や profile を作りません。

候補用の入口はダブルクリックで起動する設計です。従来の検証用アプリは引き続き実験用の起動指定を要求します。設定用 Firefox で X の通知をオンにし、作成したファイルは利用者が登録画面からアップロードします。通常のブラウザープロフィールは読み込みません。

署名済みヘルパー、Firefox の読取プログラムとその起動プログラムを manifest のハッシュに結び付けます。Apple の公証受理後にチケットを添付し、最終 ZIP を展開して署名・チケット・Gatekeeper と３つのハッシュを検証します。失敗した場合は候補 ZIP を作らず、既存ファイルも上書きしません。署名・公証時の制約は [Mac Chrome 候補の手順](mac-chrome-release-candidate.md) と共通です。

候補作成で配布設定は変わりません。Developer ID による正式署名、Apple 公証、Finder からの起動、設定用プロフィールからのファイル作成、実 X 通知と Discord 配送は未検証です。実 X の確認は利用者が後日行う方針です。内部 manifest は現在のアプリが要求する `0.1.0-mac-firefox-preview.1` を維持し、ZIP に指定した版とは区別します。
