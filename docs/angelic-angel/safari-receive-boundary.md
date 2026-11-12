# Safari の受信移譲と合成診断の境界

この記録は公開資料と、使い捨て Mac 上の合成購読に限る。通常の Safari プロフィール、Apple アカウント、端末の認証情報、本番データは調べていない。Safari のファイル受付や受信は有効化していない。

## 送信先と受信側

[RFC 8030](https://www.rfc-editor.org/rfc/rfc8030.html#section-3.2) は、アプリケーションサーバーが通知を送る push resource と、ユーザーエージェントが通知を受け取る subscription resource を分けている。JavaScript の購読情報から得た送信用 endpoint を、受信用 endpoint と同じものと仮定できない。

[WebKit の ApplePushServiceConnection](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/webpushd/ApplePushServiceConnection.mm) は、端末側の `APSConnection` の callback で受信し、topic と VAPID 公開鍵を指定して URL token を要求する。[Apple の Web Push 手順](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers) は endpoint を使うサイト運営者側の送信方式を説明している。これらの公開資料では、既存 Safari 購読の受信権をファイルだけで別サーバーに移す API は確認できない。公開されていない別の手段の不存在までは証明しない。

[WebKit の接続側検査](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/webpushd/PushClientConnection.mm) は、Apple の build でホストの Web Push entitlement と署名識別子を確認する。公開ソースの Mac build にはテスト用に entitlement 検査を省く分岐があるが、そのコードはテスト識別子を使う。これだけでは、別のアプリが既存 Safari の購読を引き継げるとは言えない。

## 合成配送結果の解釈

[Actions run 43177272704](https://github.com/lovetwice1012/comebacktwitterembed/actions/runs/43177272704) では、Apple Silicon・Intel ともに合成購読と WebKit DB の鍵・endpoint の照合、Service Worker の制御メッセージ、合成通知の provider 受付を確認した。一方、45秒以内の該当 Push イベントと表示処理は確認できず、両ジョブとも失敗した。provider の受付は受信やサーバー移譲の成功を意味しない。

同じ試験の webpushd ログには復号済み Push に対応する固定文があったが、fixture の scope と一致するとは確認できていない。[WebKit の `PushService.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/webpushd/PushService.mm) は、そのログで購読セットの概要を public、scope を sensitive として扱う。scope が伏せられる環境では、現行 fixture の scope 末尾照合が一致しないことがあり得るため、`fixtureDecoded: unconfirmed` は未配送の証拠ではない。他方、別の購読を含む可能性のある `any_decoded: true` だけから fixture の配送成功とも判断できない。

[購読セットの表示形式](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/push-api/PushSubscriptionIdentifier.cpp) には bundle identifier、任意の partition、および datastore ID の一部が含まれるが、scope は含まれない。将来、合成 DB から得た情報で照合する場合も、同じ購読セットに別 scope がないことや表示形式・ログの欠落を検証しなければ、fixture の到達証拠として扱えない。識別子・URL・鍵・通知内容をログに出さず、ユーザーの通常 DB は開かない。

現時点の制約は、合成 Service Worker の配送が確認できないことと、既存購読の端末側受信権を別サーバーへ移す経路が確認できないことである。これらを解消するまでは、Safari 対応の完成・本番利用を主張しない。

## 合成 endpoint の GET 検証

[Actions run 43207395675](https://github.com/lovetwice1012/comebacktwitterembed/actions/runs/43207395675) では、Intel・Apple Silicon の使い捨て Mac で新規に作った合成購読について、固定ホスト `web.push.apple.com` の送信用 endpoint に HTTP/2 の GET を行った。認証なしと、同じ合成購読の送信用 VAPID を付けた２条件の両方で、どちらの CPU も HTTP 405 を返した。この合成条件では送信用 endpoint を GET の受信口として使えなかった。送信用 VAPID は、受信側の資格を持つことの証拠ではない。HTTP/2 の結果は他の非公開経路や HTTP/1.1 の全挙動を証明しない。

同じ試験では、合成 Push の provider 受付と Service Worker への制御メッセージは確認したが、45秒以内の Push イベントは確認できず、両ジョブは失敗した。一時的に起動した APNs サービスの初期状態への復元は両方で確認した。endpoint・鍵・認証ヘッダー・通知内容はログに出さず、実際の X 購読や利用者のデータは使っていない。端末側の受信権を移譲する別の手段の不存在まで、この結果から断定しない。
