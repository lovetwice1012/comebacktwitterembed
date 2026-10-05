# Steam・Amazonの価格表示

URL展開時に取得できた販売価格をEmbedの価格欄へ表示する。
既存の言語設定 `defaultLanguage` と価格欄の表示設定を利用し、追加のDB設定は必要ない。

## 地域と通貨

- Steamは言語設定に対応する国のストア価格を取得する。例: `ja` は日本、
  `en-US` は米国、`en-GB` は英国、`de` はドイツ。
  URLに有効な `cc` が指定されている場合はその国を優先する。
  `es-419` はメキシコを既定地域とし、必要に応じてURLの `cc` で国を指定できる。
- Amazonはリンク先の販売地域を維持する。短縮URLは転送先で地域を判定する。
  日本のAmazonは円、米国のAmazonは米ドルなど、取得した商品の通貨を使い、
  桁区切り・小数点・通貨記号を言語設定に合わせて表示する。
- 為替換算は行わない。Amazonのドメインを言語設定に合わせて書き換えない。
  海外Amazonの同じASINが日本でも販売されているとは限らないため。

## 価格の取得

Steamは地域を指定したストアAPIとストアページから価格を取得する。
アプリ、パッケージ、バンドル、無料タイトル、セール価格に対応する。
所有済みゲームに応じて変わるバンドル価格は、未ログイン状態の表示になる。
APIの数値価格は通貨にかかわらず
100分の1単位で扱う。日本円の `120000` は1,200円である。

Amazonは商品の販売価格欄を優先し、構造化データなども補助として利用する。
評価の数値、取り消し線付き参考価格、単価を販売価格として表示しない。
価格の整数部と小数部が別のHTML要素になっているページも対象とする。

取得できない価格は空欄にし、0円とみなさない。ログイン、配送先、選択した
バリエーション、会員特典などにより、ユーザーの購入画面とは価格が異なる場合がある。
`hidden_output_items` の `price` が指定されている場合は、これまでどおり価格欄を隠す。

## 検証

```powershell
node --test scripts/test/steam.extract.test.js scripts/test/steam.parser.test.js scripts/test/amazon.extract.test.js scripts/test/amazon.parser.test.js scripts/test/provider-parsers.test.js scripts/test/provider-analytics-contract.test.js
npx eslint src/providers/steam src/providers/amazon
npm run typecheck
npm test
```

テストには地域別リクエスト、価格の表示・非表示、不正な価格、解析フォルダの
独立性を含める。実サイトの価格は変動するため固定値のネットワークテストにはしない。

2026-09-21に、実サイトへのHTTP取得からプロバイダーのEmbed生成までをローカルで確認した。
以下の価格は確認時点の値であり、最新価格を保証するものではない。

| 取得対象 | 言語・地域 | 価格欄 | 分析用の数値 |
| --- | --- | --- | --- |
| Steam App 620 | `ja` / 日本 | `¥ 1,200` | `1200` |
| Steam App 620 | `en-GB` / 英国 | `£8.50` | `8.5` |
| Steam App 620 | `de` / ドイツ | `9,75€` | `9.75` |
| Steam App 620 | `ja` / URLの `cc=us` | `$9.99` | `9.99` |
| Steam Package 7877 | `ja` / 日本 | `¥ 1,200` | `1200` |
| Steam Bundle 234 | `ja` / 日本 | `¥ 1,800 (25% オフ)` | `1800` |
| Amazon Japan ASIN B0CFPL6CFY | `ja` | `￥27,980` | `27980` |

Discordへの送信と本番環境へのデプロイは、この確認には含めない。

最終検証では `npm test` が680件成功・1件スキップ・失敗0件、両プロバイダーの
ESLintは成功した。型チェックは変更前と同じ11件の既存エラー
（`expansionTraceStore.js` と `messageCreate.js` の `state` プロパティ）で失敗し、
今回の変更に伴う新規エラーはない。
