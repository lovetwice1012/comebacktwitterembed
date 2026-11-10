# Mac向けブラウザー通知の調査

MacでもFirefox・Chrome・Brave・Edge・Safariの利用者が設定用ファイルを作り、画面から自分でアップロードできることを目標とする。専用Chromiumは同梱しない。現在のWindows用ツールはWindowsのアクセス権、プロセス管理、DPAPI、Windows Formsを使うため、Macでそのまま動作するものではない。

## 調査で確認した範囲

- FirefoxのMac版はプロファイルを `~/Library/Application Support/Firefox/Profiles/` 以下に置く。これは既定の一般プロファイルの場所であり、専用プロファイルの安全な作成・読み取りを証明するものではない。[Mozillaのプロファイル案内](https://support.mozilla.org/en-US/kb/profiles-where-firefox-stores-user-data)
- ChromiumのmacOS向け暗号処理にはKeychainとWindowsとは異なる暗号化実装がある。[Chromiumの実装](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/os_crypt/async/browser/keychain_key_provider.mm) は実装の一例であり、現行版のChrome・Braveの通知情報が必ず同じ経路を使うという証明ではない。実機で使い捨てプロファイルを作り、対象レコード・鍵の保護形式・更新時の挙動をそれぞれ確認する。
- Microsoftの組み込みWNSクライアントのポリシーはWindows向けで、macOSではサポート対象外とされている。[Microsoftのポリシー説明](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/forcebuiltinpushmessagingclient) からMac版Edgeがどの通知基盤を使うかは確定できない。WindowsのEdge処理をMacに流用せず、実機で別途調査する。
- SafariのWeb PushはAPNsとWebKitの `webpushd` を利用する。[WebKitの説明](https://webkit.org/blog/12945/meet-web-push/) と [AppleのWeb Push案内](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers) は、サイト運営者が通知を送るための公開方式を説明している。これだけでは、既存Safari購読の受信権限を別サーバーへ安全に移せることは証明できない。AppleはSafariで不可視のPushをサポートせず、通知表示を求めているため、設定用ブラウザーの受信を止める方式との関係も確認する。

Chromiumの現行公開ソースでは、[Macの鍵導出](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/os_crypt/async/browser/keychain_key_provider.mm)と[暗号処理](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/os_crypt/async/common/encryptor.cc)が `v10` のAES-CBC方式を実装し、[GCMストア](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/google_apis/gcm/engine/gcm_store_impl.cc)が端末トークンの暗号化を利用している。通知用トークンに限定した復号部品と隔離スナップショットの読み取りを接続し、Windows上の合成値と一時LevelDBで確認した。CBCには改ざん検出がなく、数字として復号できることだけでは鍵や出所の正しさを証明できない。親プロセスからパイプで呼ぶMac用読み取り入口も合成データで検証したが、配布ツール本体は未実装で、Keychain操作は実機未検証。親プロセス側には専用プロファイルの所有確認、停止、保護したスナップショットと出力、他サイト通知の説明・確認が必要。ブラウザーごとの識別子、Keychain権限、実プロファイルでの形式とサーバー受信は、使い捨てMac環境で検証する。

[ChromiumのKeychain実装](https://chromium.googlesource.com/chromium/src/+/HEAD/components/os_crypt/common/keychain_password_mac.mm)が指定するChrome用の固定項目について、利用者の確認後にMac標準 `security` コマンドで取得し、処理後に受け渡し用バッファーを消去する部品を追加した。シェルやコマンド引数に秘密値を渡さず、標準エラーを記録しない。Keychain・ユーザー操作を模擬したテストのみで、実Macでの権限ダイアログや配布ツールへの接続は未確認。この鍵は通常のChromeと共有され得るため、設定画面でアクセスの意味を明示し、専用プロファイルの通知トークン以外には使用しない。鍵自体は出力ファイルへ含めない。

[Chromiumのカテゴリ生成](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/gcm/gcm_product_util.cc)は製品名とOS名を使い、[OS名の定義](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/base/version_info/version_info.h)はMacを `Mac OS X` とする。Chromiumの[設定名のコメント](https://github.com/chromium/chromium/blob/main/chrome/common/pref_names.h)もChromeのカテゴリ例として `com.chrome.macosx` を示す。ただし既存設定の値は維持されるため、実機で取得値を照合する。定期確認の[プロトコル定義](https://chromium.googlesource.com/chromium/chromium/+/trunk/google_apis/gcm/protocol/android_checkin.proto)はWindowsを1、Macを2と定める。Macの受付と受信側は独立した `X_NOTIFICATION_CHROME_MAC_ENABLED=1` と既存のChrome設定の両方が必要で、既定では無効。隔離MariaDBと合成通知では暗号化保存・所有者制限・Mac値での定期確認・受信を検証した。本番では有効化していない。現在のWindows用データは従来どおりWindows値を使う。

## Safariの受信経路の追加調査（公開ソース）

以下はWebKit公開ソースのコミット `b82767f9fd20225dbec19f86947188825535202b` から確認した内容であり、利用者のmacOSの実装・アクセス権を実測した結果ではない。

- [PushService](https://github.com/WebKit/WebKit/blob/b82767f9fd20225dbec19f86947188825535202b/Source/WebKit/webpushd/PushService.mm#L427-L442) は購読ごとにscope、endpoint、topic、公開鍵・秘密鍵、認証秘密をまとめて保存する。受信時にはtopicでレコードを探し、保存済み鍵で復号する（[受信処理](https://github.com/WebKit/WebKit/blob/b82767f9fd20225dbec19f86947188825535202b/Source/WebKit/webpushd/PushService.mm#L943-L989)）。Webページから公開される購読情報だけでは、この受信処理に必要な秘密鍵を満たせない。
- [ApplePushServiceConnection](https://github.com/WebKit/WebKit/blob/b82767f9fd20225dbec19f86947188825535202b/Source/WebKit/webpushd/ApplePushServiceConnection.mm#L60-L105) はOS側の `APSConnection` を通して通知受信とURLトークンの取得を行う。Web Push送信先URLとWeb Push復号鍵を保存するだけで、別サーバーがAPNsの受信側になれることは示されていない。
- [WebPushDaemonMain](https://github.com/WebKit/WebKit/blob/b82767f9fd20225dbec19f86947188825535202b/Source/WebKit/webpushd/WebPushDaemonMain.mm#L122-L143) には、古い保存先からAppleのアプリグループコンテナへのDB移行処理がある。[接続側の検査](https://github.com/WebKit/WebKit/blob/b82767f9fd20225dbec19f86947188825535202b/Source/WebKit/webpushd/PushClientConnection.mm#L145-L202)には署名されたホストの権限確認があり、通常の配布ツールが同じIPCを使えるとは限らない。アクセス制御を回避せず、実機で正規の利用可能な手段を確認する。
- [公開トークンの変更時](https://github.com/WebKit/WebKit/blob/b82767f9fd20225dbec19f86947188825535202b/Source/WebKit/webpushd/PushService.mm#L926-L940)には既存購読が無効化される。ファイル作成時に保存した状態が将来も有効とは限らないため、再登録・トークン更新・競合を含めて確認する必要がある。
- [Safari 17のプロファイル](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/)ではWeb Push購読もプロファイル単位で分離される。対象の特定と誤ったプロファイルからの取り出し防止を設計に含める。

次の実機確認では、利用者の既存データではなく新規の使い捨てmacOSユーザーとテストサイトを使用する。購読の作成・復号・再起動・ブラウザー終了中の受信、トークン更新、プロファイル分離を別々に検証し、取得可能な状態とサーバーへ移せる受信権限を区別する。これらは現時点では未検証であり、Safari受付を有効にする根拠にはしない。

## 実装・検証の条件

設定ツールは対象サイトの通知情報だけを選別し、ファイル作成までを担当する。通常使用中のブラウザープロファイルやKeychain全体を読み出さない。必要な権限と、対象外サイトの通知がサーバーに到達する可能性は保存前に説明する。

Mac用のファイル作成・ダブルクリック起動・権限・ブラウザー別の通知取得・再起動・サーバー受信は、実際のmacOSと使い捨てのブラウザープロファイルで検証する。実X・Discordの確認は利用者が希望したタイミングで行う。現時点でMac向けの提供とSafari向け受信は完了していない。

Mac用保存部品は利用者の確認後に呼び出す設計とし、排他作成した一時ファイルへ書き込み、同期後に上書きしない操作で最終名を作る。Linuxコンテナ内の合成データで、既存ファイル・シンボリックリンク・同時実行・取り消しを検証した。まだセットアップ画面からは使用しない。macOSのACLやファイルシステムで実際にアクセスが限定されること、異常終了時の残存ファイル、保存ダイアログ連携は実機で確認が必要。モード `0600` の検査だけでMacのアクセス権を証明したものではない。

Keychain取得、一時コピー、通知情報の読み取り、保存前の確認、ファイル保存を呼び出す内部フローを追加した。確認前に一時コピーとKeychainの受け渡しバッファーを片付け、他サイトの通知がある場合は追加の同意を必須にする。LinuxではKeychainのみ模擬し、実際の一時LevelDBと保存部品を使ってキャンセル・同意拒否・保存を検証した。このフローはネットワーク送信を行わない。実際の説明画面・Keychain・Macブラウザー・アップロード画面との連携は未検証。

Mac向けにログイン、Xでの投稿通知、Keychainへのアクセス、他サイトの通知、保存先を案内するダイアログと、ブラウザー終了を待って保存へ進む操作フローを追加した。専用データディレクトリと既存プロファイルの確認からこのフローへ進むアプリ入口も追加した。ダイアログとブラウザーを模擬し、再試行・キャンセル・終了待ち・同一プロファイルの再利用を検証した。macOSでの表示・操作、配布物の作成・署名・ダブルクリック起動は未検証であり、利用者向けの配布物はまだない。入口のマニフェストは補助プログラムの整合性確認用であり、配布元の真正性を保証する署名の代わりにはならない。

Mac向けアプリのJavaScriptをバンドルし、Intel・Apple Silicon用のLevelDB部品とライセンスをまとめるビルド処理を追加した。LevelDB部品は固定ハッシュとMach-O形式を確認する。Windows上ではテスト用のWindows版LevelDB部品を使ってバンドルの読み込みだけを確認した。Mac用Node実行環境、ロック補助プログラム、アプリ形式の組み立てと署名は含まれておらず、これは配布可能な完成物ではない。

専用Chromeプロファイルの新規作成・照合部品も追加した。本人の非共有ディレクトリ内に新規作成し、別に保持するIDと所有マーカー、ディレクトリ・マーカーの権限、リンクの有無を照合する。既存ブラウザープロファイルを探さない。Linuxコンテナでは改変・リンク・権限異常の拒否を確認した。インストール済みChromeの署名を確認して既存ブローカーを起動し、同一プロファイルの同時起動を防ぐ処理を追加したが、署名確認とブラウザーは模擬したテストのみ。MacのACL検証・ブラウザープロセス終了と子プロセスの扱い・異常終了後のロック復旧は未検証であり、配布ツールにまだ接続しない。

専用プロファイルのIDと場所を本人の非共有ディレクトリに記録し、次回も同じプロファイルを使う部品を追加した。記録の改変や欠落、同時起動は安全側に倒し、既存データを削除・置換しない。Linuxの一時領域で再利用・並行実行・改変を検証した。途中停止で残るロックや記録欠落からの利用者向け復旧手順、macOS実機の権限確認、配布物への組み込みは未完了。

通知ストアのコピー中にLevelDBと競合しないため、既存の2個の `LOCK` ファイルに対し `fcntl(F_SETLK)` を保持する小さな補助プログラムを用意した。Linuxコンテナでコンパイルし、実際のLevelDBのオープンとの競合、片方の取得失敗時の解放、プロセス終了時の解放、リンクの拒否を検証した。専用プロファイルの起動ロックと補助プログラムのハッシュ確認を含む呼び出し処理を追加し、ロック中の再起動抑止、競合、補助プログラムの異常終了時の中断を合成環境で検証した。通知ストアと設定ファイルのみを一時コピーし、読み取り後に消去する処理へ接続した。Linuxの使い捨てLevelDBで購読情報の読み取り、Cookie・履歴・パスワードファイルの除外、失敗時の片付けを確認した。Mac向けバイナリーのビルド・署名、macOS上での競合とファイル権限の確認、配布ツールへの接続は未完了。ロックを取得できない場合にコピーを続行してはならない。
