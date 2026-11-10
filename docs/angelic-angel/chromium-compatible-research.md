# Chromium 系ブラウザーの通知基盤

Windows上の使い捨てプロファイルとローカルの試験サイトだけを使用しました。利用者の通常プロファイルや実際のXアカウントは使用していません。

- Brave 157.1.99.55 は、専用プロファイルでGoogleのプッシュ通知サービスを有効にすると、FCMの購読を作成しました。登録カテゴリは `com.brave.windows` で、Google Chromeとは異なります。試験用購読の鍵と通知を使い、Brave終了後のMCS受信・復号、サーバー確認応答を検証しました。ブラウザー自身の版とChromiumエンジンの版は別の値です。
- Microsoft Edge 157.0.4341.42 は、試験用購読にWindows通知サービスのエンドポイントを使用しました。GoogleのMCS用ストアは確認できませんでした。Microsoftの[説明](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/forcebuiltinpushmessagingclient)でも、EdgeのWindows向けプッシュ受信はWindows通知サービスを使用しています。ChromeやBrave向けのファイルをEdge用として扱う実装はできません。

Edge の使い捨てプロファイルで、内蔵クライアントと通知サービス間の接続、試験通知の受信・応答、ブラウザー再起動後の再接続を確認しました。試験用プロファイル内の保存情報と再接続時の情報には対応関係がありましたが、再接続時の署名の生成方法、移譲後の更新・失効、サーバー側での受信と応答は未検証です。試験では一時的なローカル中継を使い、通常の Edge プロファイルや Windows の設定は変更していません。認証情報や通知内容は記録しません。

この内蔵クライアントの観測を、一般的な Windows の動作と同一視しないでください。Microsoft の上記ポリシー説明では、既定は Windows OS のクライアントで、内蔵クライアントを使う設定もあります。今回の試験環境で内蔵クライアントが使われた理由と、通常の画面操作で作った購読の OS クライアント側の保存・更新方法は未確認です。

Windows の一般的な通知チャネルはアプリ・利用者・端末にひも付き、有効期限や更新があります（[Microsoft のチャネル説明](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/push-notifications/request-create-save-notification-channel)）。この説明だけから Edge の Web Push 購読に同じ有効期限が適用されるとは断定できませんが、ファイルを一度移すだけで長期運用できると決めつけず、実際の更新と失効も確認する必要があります。

Windows の公開APIでチャネルを作成する方法についても確認しました。[Microsoft の API 説明](https://learn.microsoft.com/en-us/uwp/api/windows.networking.pushnotifications.pushnotificationchannelmanager.createpushnotificationchannelforapplicationasync)では、呼び出し元アプリに結び付くチャネルを作り、別のアプリIDを指定する場合も同じパッケージ内のアプリに限定されます。そのため、別のセットアップツールがこの公開APIを呼ぶだけで、既存の Edge の購読をサーバーへ引き継げる根拠にはなりません。これは API の適用範囲に関する判断であり、Edge の内部接続や別の正式な拡張経路が存在しないことを示すものではありません。

Brave向けのGoogle通知設定はツール専用の新規プロファイルに限定し、利用者の通常プロファイルは読み書きしません。Edgeの直接受信と、その他のChromium系ブラウザーは未対応・調査中です。ブラウザーの系統だけで接続方式を推測せず、実際の通知基盤と鍵の形式を確認してから対応します。
