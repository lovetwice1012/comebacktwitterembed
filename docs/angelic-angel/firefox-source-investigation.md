# Firefox Push source investigation and current operating boundaries

調査日: 2026-10-13 JST。**ソース調査を実施。実プロファイルの抽出・実通知の移譲は未検証。**

## 調べた版と一次資料

SearchfoxのFirefox main、2026-10-12時点のrevision
`2ef09bbf347cd5c182552fdafb6d3e3da1864760`に固定して、Mozilla公式GitHubの同revisionから6ファイルを読み取った。
これはmain開発版のソースであり、インストール済みFirefoxや実際の保存ファイルを調べた結果ではない。
[Mozilla product-details](https://product-details.mozilla.org/1.0/firefox_versions.json)の調査時点の値はFirefox release `158.0`、Nightly `160.0a1`。
実試験では使用するrelease/ESR、OS、プロファイル作成手順を別途固定する。

| 固定したファイル | 確認した箇所 | SHA-256 |
|---|---|---|
| [PushRecord.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/2ef09bbf347cd5c182552fdafb6d3e3da1864760/dom/push/PushRecord.sys.mjs#L21) | constructor、toSubscription、quota、principal | `0c68b79487e2a8b138287e7b0cd7e43cc1e9f876c608ee3edb662cd642d09626` |
| [PushServiceWebSocket.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/2ef09bbf347cd5c182552fdafb6d3e3da1864760/dom/push/PushServiceWebSocket.sys.mjs#L16) | DB名/version、UAID、HELLO、PushRecordWebSocket | `4e58772feb2edb62d69ae97470c530e744ad5cd610a880ad130be59853b41156` |
| [PushDB.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/2ef09bbf347cd5c182552fdafb6d3e3da1864760/dom/push/PushDB.sys.mjs#L17) | store、indexes、read/write transaction | `403a1ff92fb018ae6fce2d653dd58641612adcc6d5c3ff076179916c7b77a6ce` |
| [PushCrypto.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/2ef09bbf347cd5c182552fdafb6d3e3da1864760/dom/push/PushCrypto.sys.mjs#L577) | key generation/export、auth、decrypt | `f406e7928786015d0f8560187e9e560b208afaa87d920a77d9484aa06733b0b8` |
| [PushService.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/2ef09bbf347cd5c182552fdafb6d3e3da1864760/dom/push/PushService.sys.mjs#L702) | ensureCrypto、receivedPushMessage | `c78bb2c60ff516d1464e8eacf92b40ff65b8a57d117043da85a73abcd92390fb` |
| [IndexedDBHelper.sys.mjs](https://github.com/mozilla-firefox/firefox/blob/2ef09bbf347cd5c182552fdafb6d3e3da1864760/dom/base/IndexedDBHelper.sys.mjs#L39) | logical DB open、transaction、upgrade path | `c7a050d72ed69cdc9d54c7bd106e9c907e226823b248549ad3496a313a8e7452` |

[Firefox Source Docs](https://firefox-source-docs.mozilla.org/dom/push/)もIndexedDBへ購読・鍵を永続化する構造を説明する。
公開Web APIの[getKey()](https://developer.mozilla.org/en-US/docs/Web/API/PushSubscription/getKey)で得られる`p256dh`は公開鍵であり、秘密鍵を取り出す公開APIではない。

## 確認できた保存項目

DB名とstore名はともに`pushapi`、DB versionは`5`、keyPathは`channelID`。
storeには`pushEndpoint`のunique index、`[scope, originAttributes]`のunique index、`originAttributes`、`quota`のindexがある。
これは論理的なIndexedDB構造の確認であり、OS上のSQLiteファイル名やbinary/structured-cloneの安全な外部decode手順の確認ではない。

| 情報 | ソース上の場所と形式 | 移譲時の扱い |
|---|---|---|
| UAID | `dom.push.userAgentID`というpreference。PushRecord内には存在しない | 購読のCHIDと同じ専用プロファイルから組み合わせる必要がある。別プロファイルのUAIDを混ぜない |
| CHID | PushRecordWebSocketの`channelID`。`keyID` getterもこの値 | 所有者・購読との紐付けに使用。ログへ生値を出さない |
| endpoint | `pushEndpoint` string | 全体をopaqueなcapabilityとして保持。末尾tokenだけに変換しない |
| service-worker scope | `scope` string | 現行Xの実scopeは実ブラウザーで未確認。PoCは`https://x.com/` originのみ受け付ける |
| origin attributes | `originAttributes` string | 同じoriginでもcontainer/private context等の識別に関係する。PoCは空値のみ |
| 公開鍵 | `p256dhPublicKey`。generateKeysはWebCryptoのraw public export | 非圧縮SEC1、65 bytes。座標と秘密鍵から再計算した公開鍵を比較 |
| 秘密鍵 | `p256dhPrivateKey`。generateKeysはextractableなECDH鍵をJWK export | P-256 JWKの`kty/crv/x/y/d/ext/key_ops`。`d`は32-byte scalar。JWKとraw公開鍵の一致を確認 |
| auth secret | `authenticationSecret`。生成16 bytes、hasAuthenticationSecretもbyteLength 16を検査 | 復号資格情報として扱い、表示・ログへ出さない |
| VAPID application key | `appServerKey` | サーバー登録時の公開鍵。秘密鍵と混同しない。値は実X購読で未確認 |
| 状態・履歴 | `version`、`pushCount`、`lastPush`、`ctime`、`recentMessageIDs`、`quota`、`systemRecord` | 復号資格情報の最小bundleへ無批判に丸ごとコピーしない。system recordは対象外 |

生成された秘密JWKをsource上でexportすることと、実プロファイルからユーザーが安全にexportできることは別の証拠である。
PushDB/IndexedDBHelperはブラウザー内部のモジュールからDBを開く。通常のXページのIndexedDBを列挙すればこの内部DBも読める、という前提は採らない。

## 接続継承で守ること

現行FirefoxのHELLOは`use_webpush:true`、broadcasts、既存購読がある場合のUAIDを送る。
調査した`_sendHello`は`channelIDs`を送らない。別UAIDの応答を受けると、Firefoxは既存購読を捨て、アプリへ変更を通知する。
PoCは同じUAIDへの継承だけを試し、変更時は`RequiresReenrollment`へ移行する。REGISTER、新CHID発行、旧X内部APIは呼ばない。

Phase 0が保存したRust互換のversion-only重複ACKを新Gatewayへそのまま適用しない。
2026-10-14の最新指示により、不明CHIDはversion重複判定より先に分岐し、有効な外形とleaseを確認後にACK102（NotDelivered）で破棄する。Xの接続は継続し、他サイトの通知を復号・永続保存・利用しない。
他サイトへの配送が失われる可能性も保存直前に説明する。元の「不明CHIDを拒否しACKしない」案をこの扱いで置き換える。
実UAID同時接続の競合・失効・配送欠落は未検証。

## 当初調査時点の抽出範囲と後続実装

以下は当初のソース調査の範囲。後続の専用profile限定・offline Gecko readerと合成native受入は `powershell-file-client.md` に記録する。実ユーザーデータを用いたG1は未実施。

この作業では`profiles.ini`、個人プロファイル、`prefs.js`、Cookie/password/history DB、実鍵を読んでいない。
実装するcollectorは**明示的に指定された合成export JSONだけの検査**。Firefox内部DBの自動走査・SQL抽出・Browser Console経由の実データ取得は実装しない。

将来の実試験では専用プロファイルを作り、手動ログインと通知設定を行い、Push-only exporterを監査する必要がある。
読み取り対象は必要なPush recordとUAID設定だけに限定する。実保存形式、停止時snapshot、抽出後の一致、他origin/他profile情報が触れないことを立証する。
`profile.stopped:true`や専用profile markerをJSONに宣言しても、実際に停止済み・専用である証明にはならない。
PoCの宣言は合成fixtureの条件であり、本番のprofile provenance/owner verificationの代用ではない。

## 現行Mozilla/Xの資料と判断限界

[旧Autopush docs](https://autopush.readthedocs.io/en/latest/)はobsoleteと表示されるため、[現行Autopush-rs docs](https://mozilla-services.github.io/autopush-rs/)を優先した。
現行[HTTP docs](https://mozilla-services.github.io/autopush-rs/http.html)はUAID/CHIDとopaque endpointを説明するが、bridge registration APIを通常アプリ開発者向けとはしていない。
[architecture](https://mozilla-services.github.io/autopush-rs/architecture.html)も受信側ACKと接続ノードの関係を説明する。これらは第三者の大量非ブラウザー受信クライアントへの現行使用許諾やSLAを示すものではない。

[Mozilla issue 997](https://github.com/mozilla-services/autopush/issues/997)の2017-09-01の非ブラウザークライアントに関する説明は、技術上可能でもunsupportedという歴史的見解である。
現在の許可と読み替えない。[Firefox terms](https://www.mozilla.org/en-US/about/legal/terms/firefox/)は2026-09-16発効で、Mozillaサービスを妨害しないこと等を定めるが、本構成の運用承認を確認できた資料ではない。

[X automation rules](https://help.x.com/en/rules-and-policies/x-automation)は2026-04更新で、非APIの自動化（サイトのスクリプト操作など）を禁止対象として説明する。
[X terms](https://x.com/en/tos)は2026-10-09発効で、公開されたinterfaceに基づくアクセス等の条件を定める。
したがってX設定を手動に限定し、Cookie/API登録/UI scriptingを回避するという制約には根拠がある。
しかし、手動購読のサーバー移譲と再配信が許容されると断定する根拠にはならない。この解釈・運用許容性は未解決で、一般提供前の独立ゲートに残す。

調査中にMozilla pushサービスrootへのHTTPS openを1回試みたが、閲覧不可だった。
WebSocket接続、Push登録、通知送信、実資格情報の使用はしていない。以後の調査はソース・文書サイトに限定した。

## PoC証拠の境界

| 条件 | 現在の証拠 |
|---|---|
| POC01: 手動X購読 | 未実施 |
| POC02: 実Firefox保存情報の安全な抽出 | ソース形式の調査のみ。抽出は未実証 |
| POC03/04: 実UAID継承・実X通知復号 | 未実施。合成鍵/loopbackは代用にならない |
| POC05: 実Firefoxとの同時接続競合 | 未実施 |
| POC06/07: 障害・UAID変更時停止 | 独立loopback PoCで試験対象。実サービス復旧証拠と区別 |
| POC08: 作者/post ID/通知種別の実データ解釈 | 未実施。1枠=監視Xアカウントの割当根拠は実payload検証が必要 |
| POC09: 運用許容性 | 一次資料を更新確認。許容性の確認は未了 |

G1は未合格。本番統合・ユーザー鍵の取り込み・公開・外部負荷試験へ進める証拠はない。
