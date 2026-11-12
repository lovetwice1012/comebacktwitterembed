# Mac Edge の配布候補

この手順は、Mac 上で未公開の Edge 用候補を作るためのものです。候補の作成ではアプリを Apple の公証サービスへ送信します。実行には、事前に用意した Developer ID Application 証明書と `notarytool` の Keychain profile が必要です。パスワードや秘密鍵をコマンド引数やチャットに記載しません。

Apple Silicon と Intel のそれぞれで、固定済み Node 24.21.0 の対象アーキテクチャの実行ファイルと LICENSE を用意します。出力先には存在しないファイルを指定します。

```sh
node scripts/build-mac-edge-release-candidate.cjs \
  arm64 1.2.3 <TEAM_ID> '<IDENTITY>' <PROFILE> \
  /absolute/path/to/node /absolute/path/to/LICENSE \
  /absolute/path/to/edge-mac-arm64-1.2.3.zip
```

`IDENTITY` は `Developer ID Application: ...` 形式の証明書名、`PROFILE` は既存 Keychain profile の名前です。Intel 用は `arm64` を `x64` に変更します。スクリプトは証明書や profile を作りません。

候補用の入口はダブルクリックで起動する設計です。Edge が利用できる状態でアプリを開き、設定用 Edge で X の通知をオンにします。ファイルは利用者が保存し、登録画面で選択してアップロードします。通常の Edge プロフィールを読み込まず、専用 Chromium も同梱しません。

校正用の Edge プロフィールは設定用プロフィールとは別に作成します。接続先の情報を確認後、起動したプロセスの終了を確認してから一時領域を削除します。終了や領域の所有権を確認できない場合は削除せず、処理を停止します。他サイトの通知または分類できない情報がある場合は、サーバーに届く可能性と現時点で破棄する扱いを確認してからファイルを保存します。

校正では、利用者の X 情報を使わない一時的な購読を作り、通知サーバーへの接続で方式を確認します。別プロフィールの校正情報と設定用プロフィールの受信情報を組み合わせた場合の実 WNS 互換性は、候補の公開前に合成購読で検証する必要があります。プロセスグループの終了確認だけで、グループ外へ離脱したすべての子孫が終了したことまでは証明できません。一時領域の検査と削除の間の同一ユーザーによる置換競合も完全には排除できません。

３つの補助プログラムを署名してから manifest にハッシュを記録します。公証受理後にチケットを添付し、最終 ZIP を展開して署名・チケット・Gatekeeper とハッシュを検証します。失敗した場合は候補 ZIP を作らず、既存ファイルも上書きしません。署名・公証時の制約は [Mac Chrome 候補の手順](mac-chrome-release-candidate.md) と共通です。

候補作成で配布設定は変わりません。Developer ID による正式署名、Apple 公証、Finder からの起動、候補 ZIP を使った実 Edge の一連の操作、実 X 通知と Discord 配送は未検証です。実 X の確認は利用者が後日行う方針です。停止中に送られた複数の通知をすべて受信できない問題も未解決のため、受付・公開 gate は無効のままにします。内部 manifest は `0.1.0-mac-edge-preview.1` を使い、ZIP に指定した版とは区別します。

2026年11月12日の [Actions run 43203905870](https://github.com/lovetwice1012/comebacktwitterembed/actions/runs/43203905870) では、Apple Silicon・Intel の両方で関連試験64件と Mac 専用試験5件が成功しました。Edge 候補 ZIP の組み立て、署名済み helper のハッシュ照合、同梱 Node と native addon の合成データ読み書き、初期ダイアログへの到達を確認しました。署名は ad-hoc、公証と Gatekeeper の応答は模擬です。正式な Developer ID 署名・Apple 公証・Finder の実操作や、実 X・Discord の通知はこの試験に含まれません。

[Actions run 43203905813](https://github.com/lovetwice1012/comebacktwitterembed/actions/runs/43203905813) では、両 CPU で各57件が成功しました。署名済み Edge を利用者情報のない別プロフィールで校正し、終了後に校正用 workspace が削除され、設定用の合成プロフィールが変わらないことを確認しました。候補 ZIP を通した操作や実 X の確認ではありません。

[Actions run 43203905959](https://github.com/lovetwice1012/comebacktwitterembed/actions/runs/43203905959) の Intel では、合成プロフィール B の情報による対照の後、別プロフィール A の校正情報と B の購読・鍵を組み合わせ、実 WNS での合成通知の受信・復号に成功しました。Apple Silicon は校正段階で失敗し、既存ログでは詳しい原因を特定できません。異なるプロフィールの組合せがすべての環境で使えることや、停止中の通知保持を示す結果ではありません。
