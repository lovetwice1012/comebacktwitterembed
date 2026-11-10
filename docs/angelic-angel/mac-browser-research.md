# Mac向けブラウザー通知の調査

MacでもFirefox・Chrome・Brave・Edge・Safariの利用者が設定用ファイルを作り、画面から自分でアップロードできることを目標とする。専用Chromiumは同梱しない。現在のWindows用ツールはWindowsのアクセス権、プロセス管理、DPAPI、Windows Formsを使うため、Macでそのまま動作するものではない。

## 調査で確認した範囲

- FirefoxのMac版はプロファイルを `~/Library/Application Support/Firefox/Profiles/` 以下に置く。これは既定の一般プロファイルの場所であり、専用プロファイルの安全な作成・読み取りを証明するものではない。[Mozillaのプロファイル案内](https://support.mozilla.org/en-US/kb/profiles-where-firefox-stores-user-data)
- ChromiumのmacOS向け暗号処理にはKeychainとWindowsとは異なる暗号化実装がある。[Chromiumの実装](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/os_crypt/async/browser/keychain_key_provider.mm) は実装の一例であり、現行版のChrome・Braveの通知情報が必ず同じ経路を使うという証明ではない。実機で使い捨てプロファイルを作り、対象レコード・鍵の保護形式・更新時の挙動をそれぞれ確認する。
- Microsoftの組み込みWNSクライアントのポリシーはWindows向けで、macOSではサポート対象外とされている。[Microsoftのポリシー説明](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/forcebuiltinpushmessagingclient) からMac版Edgeがどの通知基盤を使うかは確定できない。WindowsのEdge処理をMacに流用せず、実機で別途調査する。
- SafariのWeb PushはAPNsとWebKitの `webpushd` を利用する。[WebKitの説明](https://webkit.org/blog/12945/meet-web-push/) と [AppleのWeb Push案内](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers) は、サイト運営者が通知を送るための公開方式を説明している。これだけでは、既存Safari購読の受信権限を別サーバーへ安全に移せることは証明できない。AppleはSafariで不可視のPushをサポートせず、通知表示を求めているため、設定用ブラウザーの受信を止める方式との関係も確認する。

Chromiumの現行公開ソースでは、[Macの鍵導出](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/os_crypt/async/browser/keychain_key_provider.mm)と[暗号処理](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/os_crypt/async/common/encryptor.cc)が `v10` のAES-CBC方式を実装し、[GCMストア](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/google_apis/gcm/engine/gcm_store_impl.cc)が端末トークンの暗号化を利用している。通知用トークンに限定した復号部品と隔離スナップショットの読み取りを接続し、Windows上の合成値と一時LevelDBで確認した。CBCには改ざん検出がなく、数字として復号できることだけでは鍵や出所の正しさを証明できない。この経路は配布ツールやサーバーの受付にまだ接続しておらず、Keychain操作もしない。ブラウザーごとの識別子、Keychain権限、実プロファイルでの形式とサーバー受信は、使い捨てMac環境で検証してから統合する。

[Chromiumのカテゴリ生成](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/gcm/gcm_product_util.cc)は製品名とOS名を使い、[OS名の定義](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/base/version_info/version_info.h)はMacを `Mac OS X` とする。Chromiumの[設定名のコメント](https://github.com/chromium/chromium/blob/main/chrome/common/pref_names.h)もChromeのカテゴリ例として `com.chrome.macosx` を示す。ただし既存設定の値は維持されるため、実機で取得値を照合する。定期確認の[プロトコル定義](https://chromium.googlesource.com/chromium/chromium/+/trunk/google_apis/gcm/protocol/android_checkin.proto)はWindowsを1、Macを2と定める。送信データ生成部はMac値を明示指定できるようにしたが、実ワーカーからの指定・Macカテゴリの受付はまだ接続していない。現在のWindows用データは従来どおりWindows値を使う。

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

Mac用のファイル作成・ダブルクリック起動・権限・ブラウザー別の通知取得・再起動・サーバー受信は、実際のmacOSと使い捨てのブラウザープロファイルで検証する。実X・Discordの確認は利用者が希望したタイミングで行う。現時点でMac向けの受付やSafari向け受信は実装・検証済みではない。
