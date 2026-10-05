# プロバイダーの責務分割

通常のURL展開は引き続き `src/providers/<id>/index.js` を入口にする。
`_loader.js` に公開する `id`、URLパターン、設定、`extract()`、返却する
`SendStep[]` の契約は変えない。大きな実装は次の責務で分ける。

| モジュール | 責務 |
| --- | --- |
| `index.js` | プロバイダー登録、設定、処理の呼び出し、失敗時の応答、SendStepの返却 |
| `urls.js` | 対応URLの判定、識別子の抽出、正規化、リンクの生成 |
| `client.js` | HTTP取得、取得元のフォールバック、キャッシュとバックオフ |
| `<id>SourceParser/` | 対象サイトのHTML・埋め込みJSON・XMLなどを解析する独立したモジュール |
| `presentation.js` | Embed、ボタン、添付画像の表示設定などDiscord向けの組み立て |
| `analytics.js` | 取得データから分析用のcontent・metrics・facetsを生成 |

## パーサーモジュールの配置

パーサーは各プロバイダー内の `src/providers/<id>/<id>SourceParser/` に置く。
フォルダ名には対象サイトを含め、フォルダ単体で取り出しても何を解析するか分かるようにする。
入口は各フォルダの `index.js` とし、Amazonでは `require('./amazonSourceParser')`、
YouTubeでは `require('./youtubeSourceParser')` で利用する。
解析に必要なファイルはすべてこのフォルダ内に収め、フォルダ単体でも読み込める。

```text
src/providers/amazon/
  index.js          # プロバイダー登録・処理の組み立て
  client.js         # 通信
  parsing.js        # Bot設定を数値の解析オプションへ変換
  presentation.js   # Discord表示
  amazonSourceParser/
    index.js        # 解析モジュールの公開API
    html.js
    metadata.js
    images.js
    product.js
    music.js
    primeVideo.js
```

| プロバイダー | `<id>SourceParser/` が扱うソース |
| --- | --- |
| Amazon | 商品・Music・Prime VideoのHTML、JSON-LD、取得済みoEmbedデータ |
| BOOTH | 商品一覧HTMLのリンク、商品説明HTML、販売期間データ |
| GitHub | プロフィールページのContribution Calendar HTML |
| Instagram | 投稿・プロフィールHTML、GraphQL・oEmbedのJSON、URL識別子 |
| Spotify | 埋め込みページのNext.jsデータ、アーティストページのアルバムリンク |
| Steam | ストア・コミュニティページのメタ情報、ストアの販売価格 |
| TikTok | 投稿・プロフィールの埋め込みJSON、メディアURL候補 |
| Twitter | 上流レスポンスのJSONと、非公開・一時障害などの応答判定 |
| YouTube | ページ内JSON、Atomフィード、チャンネル識別子、URL情報 |

GitHubの画像描画・レイアウト、各プロバイダーの表示文言・設定処理は
`<id>SourceParser/` の外に置く。Amazonの説明文上限はプロバイダーで設定から数値へ変換し、
パーサーへ渡す。Steamはパーサーが返すソースの値に対し、プロバイダーで表示上限や
代替タイトルを適用する。価格表示の地域選択と取得方針は
[`localized-product-prices.md`](localized-product-prices.md) を参照する。
価格の解析には地域・表示ロケールなどの明示的な値を渡し、Bot設定そのものは渡さない。

## 変更時の境界

- 通信には入口で生成した期限付きfetchを `create*Client(fetch)` に渡す。
  状態を持つキャッシュやバックオフはクライアントに閉じ込める。
- 下位モジュールから `index.js` を読み込まない。依存関係を一方向に保つ。
- `<id>SourceParser/` からフォルダ外のファイルを読み込まない。通信・環境変数・Bot設定・
  Discord・DBには依存せず、入力されたソースと明示的な引数だけを解析する。
- グローバルRegExpの `lastIndex` を共有しないよう、公開URLパターンは
  プロバイダー生成時に複製する。
- 分析用の値は取得データから作る。表示設定で統計欄を隠しても分析値を失わない。
- 既存の `_internal` / `__test` は入口で再公開し、利用側との互換性を保つ。
- `autoWatch.js` は必要なソース解析を同じプロバイダーの `<id>SourceParser/` に任せる。
  登録、重複排除、初回カーソル、通信間隔、配信状態は従来の新着監視側に残す。
- `priceWatch.js` は価格取得と価格スナップショットの正規化だけを担当する。価格条件、通知先、配信アウトボックス、再試行は `src/providers/priceWatch/` に置く。

## 検証

`npm test` で各プロバイダーの抽出結果、URLローダー、分析契約、新着監視を確認する。
分析契約テストは入口から参照されるプロバイダー内のモジュールをたどり、
未使用のファイルや独立した `autoWatch.js` を根拠にしない。
`scripts/test/provider-parsers.test.js` は各 `<id>SourceParser/` だけを一時ディレクトリへ
コピーし、フォルダ外への依存がないことと実際に解析できることを確認する。
`npx eslint src/providers`
と `npm run typecheck` も実行し、既存のエラーと今回追加したエラーを区別する。
