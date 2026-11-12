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

2026年11月12日の [Actions run 43198478223](https://github.com/lovetwice1012/comebacktwitterembed/actions/runs/43198478223) では、Apple Silicon・Intel の両方で関連試験39件と Mac 専用試験4件が成功しました。Firefox 候補 ZIP の組み立て、同梱 Node とネイティブ addon の合成データ読み書き、初期ダイアログへの到達を確認しました。署名は ad-hoc、公証と Gatekeeper の応答は模擬です。正式な Developer ID 署名・Apple 公証・Finder の実操作や、実 X・Discord の通知はこの試験に含まれません。

同じ差分の [Actions run 43198478174](https://github.com/lovetwice1012/comebacktwitterembed/actions/runs/43198478174) では、従来の未署名 preview の組み立て・検証3件と、署名済み Firefox の XPCShell を使った合成 Push DB の読み取り、sandbox、設定用プロフィールのローカル操作など33件が、両 CPU で成功しました。これは使い捨てデータでの検証であり、実 Mozilla 通知サーバーからの配送や実利用者の X 購読の移譲を示しません。preview を正式な配布候補として提供したものでもありません。
