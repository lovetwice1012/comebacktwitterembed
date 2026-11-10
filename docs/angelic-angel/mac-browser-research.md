# Mac向けブラウザー通知の調査

MacでもFirefox・Chrome・Brave・Edge・Safariの利用者が設定用ファイルを作り、画面から自分でアップロードできることを目標とする。専用Chromiumは同梱しない。現在のWindows用ツールはWindowsのアクセス権、プロセス管理、DPAPI、Windows Formsを使うため、Macでそのまま動作するものではない。

## 調査で確認した範囲

- FirefoxのMac版はプロファイルを `~/Library/Application Support/Firefox/Profiles/` 以下に置く。これは既定の一般プロファイルの場所であり、専用プロファイルの安全な作成・読み取りを証明するものではない。[Mozillaのプロファイル案内](https://support.mozilla.org/en-US/kb/profiles-where-firefox-stores-user-data)
- ChromiumのmacOS向け同期暗号処理にはKeychainとWindowsとは異なる暗号化実装がある。[Chromiumの実装](https://chromium.googlesource.com/chromium/src/+/main/components/os_crypt/sync/os_crypt_mac.mm) は実装の一例であり、現行版のChrome・Braveの通知情報が必ず同じ経路を使うという証明ではない。実機で使い捨てプロファイルを作り、対象レコード・鍵の保護形式・更新時の挙動をそれぞれ確認する。
- Microsoftの組み込みWNSクライアントのポリシーはWindows向けで、macOSではサポート対象外とされている。[Microsoftのポリシー説明](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/forcebuiltinpushmessagingclient) からMac版Edgeがどの通知基盤を使うかは確定できない。WindowsのEdge処理をMacに流用せず、実機で別途調査する。
- SafariのWeb PushはAPNsとWebKitの `webpushd` を利用する。[WebKitの説明](https://webkit.org/blog/12945/meet-web-push/) と [AppleのWeb Push案内](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers) は、サイト運営者が通知を送るための公開方式を説明している。これだけでは、既存Safari購読の受信権限を別サーバーへ安全に移せることは証明できない。AppleはSafariで不可視のPushをサポートせず、通知表示を求めているため、設定用ブラウザーの受信を止める方式との関係も確認する。

## 実装・検証の条件

設定ツールは対象サイトの通知情報だけを選別し、ファイル作成までを担当する。通常使用中のブラウザープロファイルやKeychain全体を読み出さない。必要な権限と、対象外サイトの通知がサーバーに到達する可能性は保存前に説明する。

Mac用のファイル作成・ダブルクリック起動・権限・ブラウザー別の通知取得・再起動・サーバー受信は、実際のmacOSと使い捨てのブラウザープロファイルで検証する。実X・Discordの確認は利用者が希望したタイミングで行う。現時点でMac向けの受付やSafari向け受信は実装・検証済みではない。
