# Mac Brave の配布候補

この手順は、Mac 上で未公開の Brave 用候補を作るためのものです。候補の作成ではアプリを Apple の公証サービスへ送信します。実行には、事前に用意した Developer ID Application 証明書と `notarytool` の Keychain profile が必要です。パスワードや秘密鍵をコマンド引数やチャットに記載しません。

Apple Silicon と Intel それぞれの Mac で、固定済み Node 24.21.0 の対象アーキテクチャの実行ファイルと LICENSE を用意します。出力先は存在しないファイルを指定します。

```sh
node scripts/build-mac-brave-release-candidate.cjs \
  arm64 1.2.3 <TEAM_ID> '<IDENTITY>' <PROFILE> \
  /absolute/path/to/node /absolute/path/to/LICENSE \
  /absolute/path/to/brave-mac-arm64-1.2.3.zip
```

`IDENTITY` は `Developer ID Application: ...` 形式の証明書名、`PROFILE` は既存 Keychain profile の名前です。スクリプトは証明書や profile を作りません。`arm64` は Intel 用なら `x64` に変更します。

候補用の入口はダブルクリックで起動する設計です。従来の検証用アプリは引き続き実験用の起動指定を要求します。どちらも利用者の通常プロフィールは読み込まず、設定用プロフィールを使ってファイルを作成します。ファイルのアップロードは利用者が行います。

Chrome と同じ手順でコンポーネントを署名し、署名済みヘルパーのハッシュを manifest に保存します。Apple の公証受理後にチケットを添付し、展開した最終 ZIP の署名・チケット・Gatekeeper・ヘルパーハッシュを検証します。失敗した場合、候補 ZIP は作りません。出力は上書きせず、書き込み完了後に確定します。詳細な制約は [Mac Chrome 候補の手順](mac-chrome-release-candidate.md) と共通です。

内部 manifest は現在のアプリが要求する `0.1.0-mac-brave-preview.2` を維持します。ZIP とアプリ情報に指定した版番号とは別の内部識別です。

作成した候補は配布設定を変更しません。実際の Developer ID 署名・公証、隔離属性付き ZIP の展開、Finder 起動、専用プロフィール・Keychain・ファイル作成、実 X 通知、Discord への配送を確認するまで公開しません。実 X の確認は利用者が後日行う方針です。実験用 entry のフラグ解除や通常プロフィールの使用は行いません。

## 隔離 Mac での検証

2026年11月12日の [候補パッケージ試験 43186773849](https://github.com/lovetwice1012/comebacktwitterembed/actions/runs/43186773849) は、使い捨て Apple Silicon・Intel ランナーとも成功しました。各環境で関連試験31件と候補用試験3件が成功し、Chrome・Brave の ZIP 組立、同梱 Node によるネイティブ DB の読み書き、初期ダイアログ到達を確認しました。署名には ad-hoc 署名、公証と Gatekeeper には模擬応答を使用しています。Developer ID による正式署名・Apple 公証・Finder の実操作・実 X 通知は確認していません。

同じ変更の [Brave プレビュー試験 43186773836](https://github.com/lovetwice1012/comebacktwitterembed/actions/runs/43186773836) も両 CPU で各8件成功し、従来の実験用入口が環境フラグなしでは起動しないことと、初期ダイアログへの到達を確認しました。これらの成功は、上記の公開前検証を代替しません。
