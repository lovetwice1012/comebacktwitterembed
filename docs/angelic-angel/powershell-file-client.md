# X通知データのローカルファイル作成クライアント

2026-10-14 JST。`0.1.0-preview.4`。ユーザーの最新指示を優先し、役割は
**専用Firefoxの通知情報を抽出してPC内にファイルを作るまで**。アップロードは利用者本人がWeb画面で行う。
自動送信・自動登録・課金有効化・本番提供を行わない。

## 利用者向けの変更

preview.4は、操作と次の手順が伝わる文章へ整理した版。最新の文面・画面・実Firefoxの確認結果は `positive-copy-review.md` を参照。以下のmixed-notification証拠はpreview.3の履歴として保持する。

- 表示名を「X通知データの保存ツール」にし、元ソフト名を通常画面・配布ファイル名へ出さない。
  LICENSE等の必要な権利情報は残す。
- 「ダブルクリックで開始.cmd」→日本語Windows Forms。コマンド入力、Node/Rust、管理者起動が不要。
- 専用環境準備、Firefox起動・選択、取得内容の説明、保存先選択、実行前の同意、結果と保存先表示を用意。
  Xログイン・通知設定は本人の手動操作。
- 保存中は操作の重複・終了を防ぎ、画面応答を保ちながら終了とcleanupを待つ。
  小さい画面では本文をスクロールし、下部ボタンを常に表示する。
- 初心者向けテキストと、各公開スクリプト内の詳しい日本語コメントで、読み取り・作成・通信の範囲を示す。

## 抽出・保存の設計

1. 配布物の全ファイルhash、専用環境の所有marker、本人/SYSTEMの保護ACL、停止状態を検証する。
2. 元profileの既知parent.lockを内容非読取りで排他的に保持する。UAIDは同profileのprefs.jsの該当行だけを採用し、
   Push DBの既知basename `2918063365piupsah` の関連ファイルだけをprivate scratchへコピーする。
   Cookie、履歴、保存パスワード、一般profile一覧は取得しない。
3. Mozilla署名のFirefoxアプリ本体をprivate scratchへコピーし、そのコピーだけに固定AutoConfigコードを加える。
   元アプリ・元profileを起動/変更しない。Marionette、WebDriver、制御ポートは製品で使用しない。
4. headless/offline、push無効、通信禁止用環境で固定のGecko IndexedDB readonlyアダプターを実行する。
   schema upgradeを中止し、索引metadataとrecord数を照合する。Xは通常コンテナの厳密なscope1件だけを選び、
   ID/endpoint/公開鍵/秘密JWK/authとECDSA自己challengeによる鍵対応を検証する。
   他サイトの有効なHTTP(S) scopeはquery/fragment/port/containerを含め件数だけを数え、record値を読み出さない。
   複数X、Xコンテナ、不明なsystem scope、隠れたrecordや破損metadataは従来どおり拒否する。
5. 返すのは既知項目だけ。Job内のreader/子process終了とprivate scratch削除を確認する。
6. 他サイト設定もある場合は、この同じスナップショットから得た件数とX文書をメモリーに保持したまま、
   片付け後・新規ファイル作成直前に説明して確認する。GUIは「いいえ」を初期選択にし、同意しなければ出力しない。
   CLIは説明を確認した今回だけの `-AllowOtherNotifications` を必須とする。同意を次回へ保存しない。
   確認後に元profileを読み直さないため、確認内容と実際の保存内容が入れ替わらない。
7. 利用者が明示した新しいファイルへ、生成時から本人/SYSTEMだけのDACLを設定し、同handleで検証してから保存する。
   network drive、persistent ACL非対応volume、既存ファイル、配布/専用環境内、reparsepointを拒否する。
   機密データをstdout/GUI/通常ログへ表示しない。

完成ファイルは `format: x-notification-subscription, version: 1` のJSON。
Firefox native provenanceと、UAID/CHID/endpoint/scope/p256dh公開鍵・秘密JWK/authを最小形で持つ。
**暗号化済みファイルではない**。明示した出力としてprivate ACLで保護し、本人が信頼できるWebだけへ渡す。
一時作業と、利用者が保持する完成ファイルを区別する。サーバーの暗号化保管・認可は別の受入範囲。

他サイトの鍵・本文・サイト一覧・件数は完成ファイルに含めない。保護した作業用Push DBコピー自体には
他サイトのrecordが含まれる可能性があり、これはreader終了後、確認画面を表示する前に削除する。
共有UAIDを利用するため、ファイルをアップロードして受信を開始すると他サイトの暗号化通知や識別情報も
サーバーへ届く可能性がある。受信したデータは技術的に取得可能であること、現在は利用・復号・永続保存せず
破棄すること、破棄後にFirefox等へ届かない場合があることを説明する。
今回の同意は他サイトの通知利用を許可するものではなく、別途明確な許可を得るまで利用しない。

## 安全上のレビューで直した点

- loopbackでも無認証Marionetteの初回接続を別OSユーザーに奪われるとsystem contextが危険なため、
  native形式の研究だけに限定し製品から除外。portless AutoConfigへ切り替えた。
- FirefoxのWindows parent.lockは正常終了後も残る。存在判定をやめ、内容を読まず共有handleの取得可否で判定する。
- PID再利用を防ぐため、自分の起動記録のPIDと開始時刻を照合する。
- reader/manual起動でMOZ_/XRE_/XUL_/SELECTABLE_PROFILE_RESET_/NSPR_の継承値を除去。
  readerのAPPDATA/LOCALAPPDATA/TEMP/TMPはprivate scratchへ隔離する。
- 出力先FAT/ネットワーク等ではprivate DACLが維持できないため、volume能力と実handleのDACLを確認する。
- PS5.1のsecurity module競合を避け、ACLは直接.NET/Win32 APIで扱う。stdout/stderrをUTF-8に固定し日本語pathを維持。
- UTF-8日本語cmdはCRLF/BOMなしにし、引用と遅延展開無効化で空白/記号pathを守る。追加引数を透過しない。
- 他サイト混在、未設定、未対応形式、時間超過を安全な固定codeで区別し、秘密の例外文を画面へ転記しない。

AutoConfigの方式は [Mozillaの管理向け説明](https://support.mozilla.org/en-US/kb/customizing-firefox-using-autoconfig)、
lock動作は [公式nsProfileLock実装](https://github.com/mozilla-firefox/firefox/blob/main/toolkit/profile/nsProfileLock.cpp#L464-L505)、
Push形式は既存の `firefox-source-investigation.md` を参照する。

## 検証と再現

```powershell
npm run test:x-notification-client
npm run build:x-notification-client
# Native試験は、専用の合成fixtureと公式Firefoxを明示したときだけ実行:
$env:X_SETUP_NATIVE_FIREFOX='C:\native-test\firefox\firefox.exe'
$env:X_SETUP_NATIVE_PRIVATE_ROOT='<Tempのx-export-native-fixture-32hex配下の専用root>'
npm run test:x-notification-client:native
```

標準出力先: `artifacts/angelic-setup/x-notification-setup-0.1.0-preview.4.zip` と `.sha256`。
既存のZIP/sidecarは上書きしない。新規出力先にはbuilderの `--output` を使う。
ZIPは明示9ファイル＋manifestだけで、Firefox本体・profile・鍵・実験コードを含めない。
自己manifestはコード署名ではなく、信頼できる別経路のZIP hash照合と区別する。

| 証拠 | 範囲 |
|---|---|
| `mixed-notification-client-tests.xml` | 新版のreader・パッケージ・明示同意・Node起動器の78件成功。後続の起動入口・PID限定ダイアログ検証は `mixed-notification-startup-final-tests.xml` の54件成功 |
| `mixed-notification-native-tests.xml` | 新版の実Gecko合成fixture6件成功。両PS/GUI、Xだけの出力、他サイトquery/container混在の明示確認、ACL、原本不変、cleanup |
| `powershell-file-client-tests.xml` | パッケージ・CLI・両Forms・cmd実起動・29件のJS/WebCrypto異常系。41成功、失敗/skip/TODO 0 |
| `powershell-file-client-native-tests.xml` | 公式Firefoxの実保存形式に合成recordを保存したfixture。両CLI・両GUI bridge・日本語path・private ACL・既存出力保持・原本hash不変・別profile環境混入防止・中止cleanup。5成功、失敗/skip/TODO 0 |
| `experiments/angelic-exporter/evidence.portless-export.json` | portless実験と正式wrapperの秘密を含まない証拠。旧Marionette研究は製品安全性の証拠へ流用しない |
| `powershell-file-client-validation.json` | 最終ソース・ZIP・JUnitのSHA256、受入範囲 |

Native runtime: Firefox Nightly **160.0a1 / Build 20261013210959**、Windows PowerShell 5.1とPowerShell 7。
Mozilla署名確認と、[同一daily buildの公開checksums](https://archive.mozilla.org/pub/firefox/nightly/2026/10/2026-10-13-21-09-59-mozilla-central/firefox-160.0a1.en-US.win64.checksums)
のSHA256/SHA512一致を確認した。rolling latestのZIP/checksumが更新途中で一時不一致になった経緯も証拠に残す。
このruntimeは試験だけで使い、製品ZIPに含めない。

## 残る受入

**実際のX通知購読、実ユーザーの鍵/通常profile、実通知受信復号、Web受付・登録・送達、本番環境、
全Firefox版・全Windows環境の動作はこの試験で確認していない。** 合成データを本物の移譲成功と扱わない。
G1、運用許容性、本番公開・デプロイ・実データ取り込みの承認は引き続き別ゲート。
今回の完成範囲は、監査可能な配布用ローカルファイル作成クライアントとその限定受入である。
最終のソース・配布hash・各試験の照合は `mixed-notification-validation.json`。旧版の証拠は当時の結果として保持する。

後続のWeb統合は `x-notification-onboarding.md` に記録する。専用の説明・手動ファイル登録画面と公開鍵による暗号化保存を追加し、`onboarding-native-tests.xml` では両CLI・両GUIが作成した実ファイルをWeb受付の厳密なvalidatorへ渡すところまで追加検証した。実保存形式のrecordは合成データであり、実X購読の受信成功や本番アップロードを証明しない。
