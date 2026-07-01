comebacktwitterembed Web Dashboard 仕様書

1. 目的

comebacktwitterembed の設定項目が短期間で大幅に増加しているため、Discord slash commandだけではなく、WebダッシュボードからBotの挙動を直感的かつ安全にカスタマイズできるようにする。

本ダッシュボードは、単なる設定項目一覧・DB編集画面ではなく、利用者が以下を理解しながら設定できる管理画面として設計する。

* この設定を変更するとBotの出力がどう変わるか
* どのproviderに効く設定なのか
* どのチャンネル・ロール・ユーザーに影響するのか
* 現在の設定がデフォルトからどれだけ変わっているのか
* 設定同士に矛盾や競合がないか
* 保存前後で何が変わるのか
* 問題が起きたときに誰が何を変更したのか

既存BotはMySQLの設定を直接参照しているため、Webダッシュボードは既存MySQLスキーマと完全互換で動作することを最優先とする。

2. 基本方針

2.1 設定カタログ駆動

Webダッシュボードは、設定項目をハードコードした画面として作らない。

最新コードでは src/providers/_setting_specs.js に設定カタログが存在し、COMMON_SETTING_SPECS、SETTING_SPEC_CATALOG、getProviderSettingSpecs(provider) によって、共通設定とprovider別設定が合成される構造になっている。Web側もこの構造を踏襲する。

Web側では、設定項目を次のようなメタデータとして扱う。

type SettingSpec = {
  key: string;
  settingKey: string;
  label: LocalizedText;
  description: LocalizedText;
  kind:
    | "overview"
    | "providerEnabled"
    | "bool"
    | "choice"
    | "targets"
    | "buttonVisibility"
    | "bannedWords"
    | "outputVisibility";
  choices?: Array<{
    label: LocalizedText | string;
    value: string;
  }>;
  parseValue?: (value: string) => unknown;
  outputItems?: Array<{
    value: string;
    label: LocalizedText | string;
    description?: LocalizedText | string;
  }>;
  category?: string;
  impactLevel?: "low" | "medium" | "high" | "danger";
  recommended?: boolean;
  advanced?: boolean;
  dependencies?: string[];
  conflicts?: string[];
};

2.2 Bot互換性最優先

Webダッシュボードが保存した設定は、既存Botの _provider_settings.js からそのまま読み取れる必要がある。

最新コードでは PROVIDER_DEFAULTS に多数の設定キーが追加され、PROVIDER_SETTING_COLUMNS でDBカラムとの対応が定義されている。

Web側はこの対応関係を壊さない。

2.3 provider追加に強い設計

今後も短期間で大量に設定項目が増える前提とする。

そのため、providerを追加したときにWeb側で必要な作業は原則として以下だけにする。

1. provider側に settings を追加する
2. 必要なら SETTING_SPEC_CATALOG に設定specを追加する
3. 必要ならDBカラムをmigrationで追加する
4. Web dashboardは自動的に表示・編集対象にする

React画面側でproviderごとの専用フォームを毎回追加する設計は禁止する。

2.4 UX重視

本ダッシュボードは「設定ができる」だけでは不十分。

設定の意味、影響、推奨値、デフォルト値、変更差分、競合、危険度、反映範囲を利用者が理解できるようにする。

特に、providerが増えた状態では、設定項目の列挙だけでは利用者が迷うため、以下を必須とする。

* 設定検索
* provider横断検索
* カテゴリ分類
* よく使う設定
* 危険設定
* 詳細設定
* 変更差分プレビュー
* 出力プレビュー
* 設定プリセット
* 設定テンプレート
* 設定診断
* 監査ログ
* 変更履歴からの復元

3. 採用技術

3.1 フロントエンド

Next.js
TypeScript
shadcn/ui
Tailwind CSS
React Hook Form
Zod

3.2 認証

Discord OAuth2
Auth.js / NextAuth.js

使用scope:

identify
guilds

必要に応じてBot Tokenでguild情報、channel情報、role情報を取得する。

3.3 バックエンド

Next.js Route Handlers
Server Actionsは補助的に使用

DB保存、Discord API呼び出し、権限チェックは必ずサーバー側で行う。

3.4 DB

既存MySQL
Prisma

注意:

* 既存BotのDBスキーマを正とする
* Prisma migrateで既存テーブルを破壊しない
* Prismaは主に型安全な読み書き・補助テーブル追加に使う
* 既存migrationとの競合を避ける

3.5 Bot

既存Botは以下のまま維持する。

discord.js
mysql
express
node-fetch

最新 package.json では discord.js、express、mysql、node-fetch が利用されている。

4. ディレクトリ構成

既存Botを壊さないため、Webダッシュボードは独立ディレクトリとして追加する。

comebacktwitterembed/
  index.js
  src/
    providers/
      _setting_specs.js
      _provider_settings.js
      _output_controls.js
      _output_visibility.js
    lifecycle/
    commands/
    handlers/
  migrations/
  scripts/
  package.json
  dashboard/
    app/
    components/
    features/
    lib/
    prisma/
    public/
    package.json

4.1 dashboard内の推奨構造

dashboard/
  app/
    layout.tsx
    page.tsx
    dashboard/
      page.tsx
      [guildId]/
        page.tsx
        providers/
          page.tsx
          [providerId]/
            page.tsx
        settings/
          page.tsx
        logs/
          page.tsx
        diagnostics/
          page.tsx
        preview/
          page.tsx
        media/
          page.tsx
  components/
    ui/
    dashboard/
    settings/
    providers/
    preview/
    audit/
    media/
  features/
    auth/
    discord/
    guilds/
    providers/
    settings/
    audit/
    media/
    diagnostics/
  lib/
    prisma.ts
    discord.ts
    permissions.ts
    settings-catalog.ts
    settings-db.ts
    settings-validation.ts
    settings-diff.ts
    settings-preview.ts
    audit-log.ts

5. 認証・認可仕様

5.1 Discordログイン

ユーザーはDiscord OAuth2でログインする。

ログイン後、最低限以下をセッションに保持する。

type DashboardSession = {
  user: {
    id: string;
    username: string;
    globalName?: string;
    avatarUrl?: string;
  };
  accessToken: string;
  expiresAt: number;
};

UX条件

* 未ログイン時はトップページに「Discordでログイン」を表示する
* ログイン後は管理可能なサーバー一覧へ遷移する
* セッション切れ時は、作業中の未保存変更をlocalStorageに一時退避する
* 再ログイン後、未保存変更を復元する
* 権限不足時は単に403表示にせず、「必要な権限」と「現在不足している権限」を表示する

5.2 guild一覧

表示対象は以下を満たすguildのみ。

- ユーザーが所属している
- Botが導入されている
- ユーザーが設定閲覧権限を持っている

設定変更可能かどうかは別で判定する。

guildカード表示項目

- サーバーアイコン
- サーバー名
- guild_id
- Bot導入状態
- 自分の権限
- 設定変更可能/閲覧のみ
- 有効provider数
- 最近の設定変更
- 注意状態

UX条件

* サーバー名検索
* guild ID検索
* 最近使ったサーバーを上位表示
* 設定未完了サーバーをハイライト
* 問題があるサーバーに警告バッジを表示
* Bot未導入サーバーには招待導線を表示
* 権限不足サーバーには「管理者に依頼」用の説明テキストを表示

5.3 権限判定

既存 /guisetting は以下のいずれかを持つ場合に設定権限ありとしている。

ManageChannels
ManageGuild
Administrator

Webダッシュボードも基本的にこれに合わせる。

操作別権限

操作	必要権限
設定閲覧	ManageChannels / ManageGuild / Administrator
provider有効化・無効化	ManageGuild / Administrator
通常設定変更	ManageChannels / ManageGuild / Administrator
全provider一括変更	ManageGuild / Administrator
設定インポート	ManageGuild / Administrator
危険設定変更	ManageGuild / Administrator
監査ログ閲覧	ManageGuild / Administrator
メディア配信設定変更	Administrator または Bot運用者

UX条件

* 操作ボタンは権限に応じてdisabledにする
* disabledの場合は理由をtooltipで表示する
* API側でも必ず同じ権限チェックを行う
* 権限不足の状態で直URLアクセスした場合も、安全に拒否する
* 403ページには「必要権限」「現在の権限」「管理者向け説明」を表示する

6. 設定カタログ仕様

6.1 設定の種類

最新コードでは、以下の設定種別が存在する。

overview
providerEnabled
bool
choice
targets
buttonVisibility
bannedWords
outputVisibility

/guisetting はspecの kind に応じてUIを切り替えているため、Web側も同じ分類を採用する。

6.2 common設定

全providerに共通する設定。

enabled

providerの有効・無効。

目的:

* このサーバーで該当providerのURLを展開するかを制御する

DB:

guild_provider_settings.enabled

型:

boolean | undefined

UX:

* provider一覧で即時切り替え可能
* 詳細画面でも変更可能
* デフォルト有効/無効を表示する
* 「無効化するとこのproviderのURLは展開されません」と明示する
* 全provider無効化は危険操作として確認ダイアログを出す

disable

特定のユーザー、チャンネル、ロールで展開を止める。

DB:

guild_provider_disable_targets

型:

{
  user: string[];
  channel: string[];
  role: string[];
}

UX:

* ユーザー・チャンネル・ロールをそれぞれタブで管理
* Discord APIで名前を解決して表示
* ID直入力も許可
* 存在しないIDは「解決できないID」として表示
* 追加時に重複を自動排除
* 一括追加テキストエリアを用意
* 削除前に対象数を表示
* どのproviderに対するdisableかを常に明示
* all providers適用時は影響範囲を確認する

defaultLanguage

provider出力の標準言語。

DB:

guild_provider_settings.default_language

型:

"en" | "ja" | undefined

UX:

* English / Japanese の選択
* 日本語サーバーならJapaneseを推奨表示
* 言語に影響する出力例をプレビューする
* provider側で未対応の場合は「一部の文言のみ反映」と表示する

editOriginalIfTranslate

翻訳ボタン押下時に元のBot応答を編集するか。

DB:

guild_provider_settings.edit_original_if_translate

型:

boolean

UX:

* 「元メッセージを置き換える」か「別メッセージで送る」かの説明を出す
* 利用者が翻訳結果を共有したい場合の推奨値を提示する
* ログ用途や会話流れへの影響を説明する

extract_bot_message

BotやWebhookが投稿したURLも展開するか。

DB:

guild_provider_settings.extract_bot_message

型:

boolean

UX:

* ループリスクの注意を表示
* Webhook連携サーバー向けには有用であることを説明
* 有効化時は「他Botの投稿も展開対象になります」と確認する
* Bot自身の投稿は無限ループしない設計であることを確認できる診断項目を設ける

button_invisible

Bot応答に付くボタンを非表示にする。

DB:

guild_provider_button_visibility

型:

{
  showMediaAsAttachments?: boolean;
  showAttachmentsAsEmbedsImage?: boolean;
  translate?: boolean;
  delete?: boolean;
  savetweet?: boolean;
}

注意:

* savetweet はTwitter専用
* twitter以外には保存しない

UX:

* ボタンごとのプレビューを表示
* 「非表示」と「無効化」は別物であることを説明
* provider別に利用できるボタンだけ表示
* 一括で「全部表示」「全部非表示」を選べる
* 非表示にした結果、利用者が代替操作できなくなる場合は警告する

button_disabled

特定対象のボタン操作を止める。

DB:

guild_provider_button_disabled_targets

型:

{
  user: string[];
  channel: string[];
  role: string[];
}

UX:

* disableとの違いを説明する
    * disable: 展開そのものを止める
    * button_disabled: 展開後のボタン操作だけ止める
* ユーザー、チャンネル、ロール別に管理
* 解決済み表示名とIDを併記
* 大量登録・大量削除に対応する

failure_display_policy

providerのメタデータ取得に失敗したときの出力方針。

DB:

guild_provider_settings.failure_display_policy

型:

"silent" | "source_link" | "error_summary"

選択肢:

silent: 何も送らない
source_link: 元リンクだけ送る
error_summary: 短いエラー概要を送る

最新コードでは buildFailureResponse がこの方針に応じて失敗時レスポンスを構築している。

UX:

* silent は荒れにくいが、失敗が分かりにくい
* source_link は最低限リンクを残せる
* error_summary は管理者向けに便利だが、通常チャンネルではノイズになりやすい
* providerごとの推奨値を表示
* エラー率が高いproviderでは source_link 推奨を出す

7. 出力カスタマイズ仕様

今回の重要変更点は、Botの出力制御が増えていること。

_output_controls.js には、表示密度、メディア表示モード、失敗時表示方針、hidden output itemsなどの共通出力制御が実装されている。

7.1 display_density

出力密度。

DB:

guild_provider_settings.display_density

型:

"compact" | "standard" | "detail"

意味:

compact: 重要情報だけを表示
standard: 標準的な情報量
detail: 詳細メタデータも表示

UX:

* ラジオカード形式で表示する
* 各密度のプレビューを横並びで表示する
* compactは雑談チャンネル向け
* standardは標準推奨
* detailは情報収集・ログ用途向け
* providerごとにcompactで非表示になる項目を確認できるようにする

7.2 media_display_mode

メディア表示方式。

DB:

guild_provider_settings.media_display_mode

型:

"embed" | "attachment" | "thumbnail_only" | "link_only"

意味:

embed: embed画像として表示
attachment: Discord添付ファイルとして送信
thumbnail_only: サムネイルだけ表示
link_only: メディアURLだけ表示

最新コードでは、applyMediaDisplayToStep がこの設定に応じてembed画像、添付、サムネイル、リンク表示へ切り替える。

UX:

* 4種類をカードで選択
* 各モードのメリット・デメリットを表示
* Discordの表示上限やファイルサイズ制限への注意を表示
* attachmentはチャンネルが重くなる可能性を警告
* link_onlyは最も軽いが見た目が弱くなると説明
* media switch buttonが使えなくなる場合は通知する

7.3 hidden_output_items

provider別に特定の出力項目を隠す。

DB:

guild_provider_settings.hidden_output_items

保存形式:

TEXTにJSON配列として保存

型:

string[]

最新コードでは normalizeHiddenOutputItems が配列、JSON文字列、カンマ区切り文字列を正規化できる。

UX:

* providerごとに非表示可能な項目をチェックリスト表示
* 出力項目の説明を表示
* 「この項目を隠すと何が消えるか」をプレビューする
* compact設定で自動的に消える項目と、手動で隠した項目を区別する
* hidden_output_itemsは上級設定として扱う
* 項目が増えてもUI側は outputItems を読むだけで対応する

8. provider別設定仕様

8.1 Twitter / X

provider定義:

provider_id: twitter
enabledByDefault: true

Twitterはデフォルト有効。

対象設定

Twitter providerは以下の設定を持つ。

bannedWords
sendMediaAsAttachmentsAsDefault
deletemessageifonlypostedtweetlink
deletemessageifonlypostedtweetlink_secoundaryextractmode
alwaysreplyifpostedtweetlink
anonymous_expand
display_density
media_display_mode
twitter_stats_layout
twitter_text_mode
twitter_quote_mode
twitter_quote_layout
hidden_output_items
quote_repost_do_not_extract
quote_repost_max_depth
legacy_mode
passive_mode
secondary_extract_mode
secondary_extract_mode_multiple_images
secondary_extract_mode_video

bannedWords

取得したタイトル、本文、キャプション、説明文に指定語句が含まれる場合、展開を送信しない。

型:

string[]

保存先:

guild_provider_banned_words

UX:

* タグ入力
* 改行区切り一括追加
* CSV貼り付け対応
* 大文字小文字の扱いを説明
* NFC正規化後の値を表示
* 重複は自動削除
* 禁止ワードが多い場合は検索可能にする
* 「このワードでテスト」機能を用意する

sendMediaAsAttachmentsAsDefault

メディアを添付ファイル優先で送信する。

型:

boolean

UX:

* 現在は media_display_mode=attachment と意味が近いため、将来的に統合または互換表示する
* 古い設定として残しつつ、UIでは「従来設定」と表示する
* media_display_mode が存在する場合はそちらを優先する設計に寄せる

deletemessageifonlypostedtweetlink

リンクだけの元投稿を削除する。

型:

boolean

UX:

* BotにManage Messagesが必要であることを明示
* 権限が不足している場合は警告
* 削除される条件を例で表示
* 「URLだけの投稿のみ削除」と明記
* 雑談チャンネルでは有用、ログ用途では非推奨などの説明を出す

deletemessageifonlypostedtweetlink_secoundaryextractmode

secondary extract mode時にもリンクだけの元投稿を削除する。

注意:

* 既存キーの綴りは secoundary のまま維持する
* Web側で勝手に secondary に改名しない

UX:

* secondary extract modeがOFFの場合は無効状態または依存警告を表示
* ONにすると元投稿削除の条件が変わることを説明する

alwaysreplyifpostedtweetlink

Botの展開結果を元投稿への返信として送信する。

型:

boolean

UX:

* 返信形式と通常投稿形式のプレビューを表示
* 会話の流れを追いやすくする設定として説明
* 大量展開チャンネルではON推奨を表示

anonymous_expand

展開者名を匿名化する。

型:

boolean

UX:

* フッターやauthor表示がどう変わるかをプレビュー
* ログ用途ではOFF推奨、プライバシー重視ではON推奨
* 実際のDiscord user IDが監査ログに残るかどうかも明示する

twitter_stats_layout

返信、リポスト、いいね数の表示形式。

型:

"description" | "fields" | "hidden"

UX:

* description: 本文中に1行で表示
* fields: embed fieldsとして表示
* hidden: 表示しない
* compact densityではhidden推奨を出す
* detail densityではfields推奨を出す

twitter_text_mode

Twitter本文の表示方式。

型:

"normal" | "link_only" | "hidden"

UX:

* normal: ツイート本文 + 元リンク
* link_only: 元リンクだけ
* hidden: 本文欄を隠す
* 匿名運用やメディア中心運用では link_only / hidden を推奨表示する

twitter_quote_mode

引用ツイートの表示方式。

型:

"full" | "summary" | "hidden"

UX:

* fullは情報量が多い
* summaryは見やすい
* hiddenは最も静か
* quote depthと組み合わせた影響を表示する

twitter_quote_layout

引用ツイートの並べ方。

型:

"separate" | "inline"

UX:

* separate: 後続返信として分離
* inline: Discord制限内で同じ応答にまとめる
* embed数制限に達した場合の挙動を説明する

quote_repost_do_not_extract

引用リポストを展開しない。

型:

boolean

UX:

* quote modeやquote depthと競合するため、ON時は関連設定を視覚的にグレーアウトする
* 実際にはDB上は残してよいが、UIでは「この設定が優先されます」と表示する

quote_repost_max_depth

引用リポストを何段まで展開するか。

型:

0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10

意味:

0 = 無制限

UX:

* 無制限は危険設定として扱う
* 深い引用はスパム的に増える可能性を警告
* 推奨値は1または2
* quote modeがhiddenの場合は影響しないことを表示する

legacy_mode

元リンクのDiscord標準プレビューを抑制する。

型:

boolean

注意:

* secondary_extract_mode と排他
* 現コードでも legacy_mode=true の場合は secondary_extract_mode=false にしている。

UX:

* secondary_extract_modeとの排他をUIで明示
* ONにするとsecondary_extract_modeをOFFにする確認を出す
* BotにManage Messagesが必要な場合は警告

passive_mode

Twitter出力を簡易表示する。

型:

boolean

UX:

* display_densityとの違いを説明
* 将来的にはdisplay_densityへ統合する候補として扱う
* compact densityと併用時の出力例を表示する

secondary_extract_mode

メディア条件付き展開。

型:

boolean

注意:

* legacy_mode と排他
* 現コードでも secondary_extract_mode=true の場合は legacy_mode=false にしている。

UX:

* ONにすると条件設定欄を展開
* 複数画像・動画のどちらを対象にするか表示
* 条件に合わないツイートは展開されないことを説明する

secondary_extract_mode_multiple_images

複数画像をsecondary extract対象にする。

型:

boolean

UX:

* secondary_extract_modeがOFFの場合は依存警告
* 画像1枚の投稿は対象外であることを説明する

secondary_extract_mode_video

動画をsecondary extract対象にする。

型:

boolean

UX:

* secondary_extract_modeがOFFの場合は依存警告
* 動画付きツイートのみ展開対象にする用途を説明する

Twitter hidden_output_items

Twitterで非表示可能な出力項目。

article_card
article_title
article_preview
article_image
media_count
media_type
sensitive_media
stats

UX:

* 「記事カード」「メディア情報」「統計情報」などカテゴリ分けする
* twitter_stats_layout=hiddenの場合、statsのhidden_output_itemsとの重複を整理して表示する
* sensitive_mediaを隠す場合は注意文を出す

8.2 Pixiv

provider定義:

provider_id: pixiv
enabledByDefault: false

Pixivはデフォルト無効。

対象設定

Pixiv providerは以下の設定を持つ。

anonymous_expand
alwaysreplyifpostedtweetlink
deletemessageifonlypostedtweetlink
legacy_mode
display_density
media_display_mode
pixiv_images_per_step
pixiv_caption_max_length
pixiv_tag_limit
hidden_output_items

pixiv_images_per_step

1回のBot応答に含めるPixiv画像枚数。

型:

4 | 10

UX:

* 4枚: 見やすい、軽い、標準推奨
* 10枚: まとめて表示できるが重い
* Discord embed上限に関する説明を表示
* 大量画像作品での表示例をプレビューする

pixiv_caption_max_length

Pixiv説明文の最大表示文字数。

型:

0 | 140 | 350 | 700 | 1200

意味:

0 = 説明文非表示

UX:

* 文字数ごとのプレビュー
* R-18タグ等とは別設定であることを説明
* 長文説明を重視するサーバーでは700以上推奨

pixiv_tag_limit

Pixivタグ表示数。

型:

0 | 5 | 10 | 20 | "all"

UX:

* 0: タグ非表示
* all: すべて表示
* タグが多い作品ではembedが長くなることを警告
* display_densityに応じた推奨値を出す

Pixiv hidden_output_items

ai
maturity
type
ugoira_media
pages
tags

UX:

* AI生成ラベル、R-18/R-18Gラベルを隠す場合は強めの注意を表示
* tags非表示とpixiv_tag_limit=0の関係を整理して表示
* ugoira_mediaを隠すと動きのあるメディアが出なくなる可能性を説明

8.3 YouTube

provider定義:

provider_id: youtube
enabledByDefault: false

YouTubeはデフォルト無効。

対象設定

YouTube providerは以下の設定を持つ。

anonymous_expand
alwaysreplyifpostedtweetlink
deletemessageifonlypostedtweetlink
display_density
media_display_mode
youtube_video_list_limit
youtube_description_max_length
hidden_output_items

youtube_description_max_length

YouTube動画、プレイリスト、チャンネルembedの説明文最大文字数。

型:

0 | 200 | 500 | 700 | 1000 | 1400

UX:

* 0は説明文非表示
* compactなら200推奨
* standardなら700または1000推奨
* detailなら1400推奨
* 動画・プレイリスト・チャンネルのプレビューを切り替えられるようにする

youtube_video_list_limit

プレイリストやチャンネルで表示する動画リスト件数。

型:

0 | 3 | 5 | 10

UX:

* 0は動画リスト非表示
* compactでは3件推奨
* standardでは5件推奨
* detailでは10件推奨
* hidden_output_itemsの video_list と重複する場合は片方に誘導する

YouTube hidden_output_items

duration
type
uploaded
stats
video_list

UX:

* statsを隠すと再生数・高評価・登録者数などが消える
* video_listを隠すとplaylist/channelの一覧性が下がる
* typeを隠すとShorts/動画/プレミアなどの区別が弱くなる

8.4 Niconico

provider定義:

provider_id: niconico
enabledByDefault: false

Niconicoはデフォルト無効。

対象設定

Niconico providerは以下の設定を持つ。

anonymous_expand
alwaysreplyifpostedtweetlink
deletemessageifonlypostedtweetlink
display_density
media_display_mode
niconico_description_max_length
hidden_output_items

niconico_description_max_length

Niconico説明文の最大表示文字数。

型:

0 | 200 | 350 | 700 | 900 | 1400

UX:

* compactなら200
* standardなら700または900
* detailなら1400
* 長い説明文を出すとチャンネルが流れやすいことを説明

Niconico hidden_output_items

views
comments
mylists
likes
duration
uploaded
series
owner
uploader
genre
tags

UX:

* 統計系、投稿者系、分類系に分ける
* ownerを隠すと投稿者表示がNiconico一般表示になることを説明
* tagsを隠すと検索・分類の情報が減ることを説明

8.5 TikTok

対象設定:

tiktok_hq
tiktok_description_max_length
tiktok_image_limit
tiktok_video_fallback_mode
display_density
media_display_mode
failure_display_policy
hidden_output_items

tiktok_hq

TikTok動画を高画質優先で取得・添付する。

型:

boolean

UX:

* 高画質化により処理時間やファイルサイズが増える可能性を説明
* 低速環境ではOFF推奨
* メディア表示モードがattachment以外の場合の影響を説明

tiktok_description_max_length

TikTok説明文最大文字数。

型:

0 | 200 | 350 | 700 | 900

tiktok_image_limit

TikTokフォト投稿の画像表示数。

型:

1 | 4 | 10

tiktok_video_fallback_mode

TikTok動画を添付できない場合の代替表示。

型:

"video_url" | "thumbnail_only" | "silent"

UX:

* video_url: 利用者が開けるリンクを残す
* thumbnail_only: 見た目は残すが動画は見られない
* silent: 追加表示なし
* 失敗時policyとの違いを説明する

8.6 Instagram

対象設定:

instagram_caption_max_length
instagram_media_limit
display_density
media_display_mode
hidden_output_items

instagram_caption_max_length

Instagramキャプション最大文字数。

型:

0 | 500 | 1200 | 3000

UX:

* 0はキャプション非表示
* 3000は非常に長くなる可能性があるため詳細向け
* 雑談チャンネルでは500推奨

instagram_media_limit

Instagramカルーセルの最大メディア数。

型:

1 | 4 | 10

UX:

* 1は軽い
* 4は標準
* 10は全表示寄り
* attachmentモードとの組み合わせで重くなる場合は警告

8.7 GitHub

対象設定:

github_card_style
display_density
media_display_mode
hidden_output_items

github_card_style

GitHubリポジトリカードの表示方式。

型:

"generated" | "github"

UX:

* generated: Bot生成カード
* github: GitHub公式OGPカード
* 表示例を左右比較できるようにする
* GitHub公式カードは見た目が安定するが情報量が少ない可能性を説明

8.8 Steam

対象設定:

steam_description_max_length
steam_image_source
display_density
media_display_mode
hidden_output_items

steam_description_max_length

Steam説明文最大文字数。

型:

0 | 200 | 350 | 700 | 900

steam_image_source

Steam画像ソース。

型:

"header" | "screenshot" | "thumbnail"

UX:

* header: 安定したヘッダー画像
* screenshot: ゲーム画面を見せやすい
* thumbnail: 軽量
* NSFW/年齢制限系の扱いが必要なら将来設定を追加できるようにする

8.9 Booth

対象設定:

booth_description_max_length
booth_image_limit
booth_adult_display_mode
display_density
media_display_mode
hidden_output_items

booth_description_max_length

Booth説明文最大文字数。

型:

0 | 200 | 350 | 700

booth_image_limit

Booth商品画像数。

型:

1 | 4 | 10

booth_adult_display_mode

Booth成人向け商品メディアの扱い。

型:

"normal" | "metadata_only" | "spoiler_attachment"

UX:

* normal: 通常表示
* metadata_only: メディアを出さずメタ情報中心
* spoiler_attachment: spoiler添付
* 成人向けが明示される可能性があるため危険設定として扱う
* サーバールールに合わせる説明を表示

8.10 Spotify

対象設定:

spotify_description_max_length
display_density
media_display_mode
hidden_output_items

spotify_description_max_length

Spotify説明文最大文字数。

型:

0 | 200 | 350 | 700

UX:

* track / album / playlist / artistでプレビューを変える
* compactでは説明文を短くする

8.11 Twitch

対象設定:

twitch_description_max_length
display_density
media_display_mode
hidden_output_items

twitch_description_max_length

Twitch説明文最大文字数。

型:

0 | 200 | 350 | 700 | 900 | 1400 | 1500

UX:

* 配信中・クリップ・チャンネルで出力差がある場合に対応できる設計にする
* viewer countなどのhidden項目追加に備える

8.12 Amazon

対象設定:

amazon_description_max_length
display_density
media_display_mode
hidden_output_items

amazon_description_max_length

Amazon説明文最大文字数。

型:

0 | 200 | 350 | 700

UX:

* 価格・レビュー・画像などの出力項目が今後増える可能性を考慮
* アフィリエイトや地域差がある場合の注記領域を用意する

9. DB仕様

9.1 既存テーブル

既存Botが使用する主なテーブル。

providers
guilds
guild_provider_settings
guild_provider_disable_targets
guild_provider_banned_words
guild_provider_button_visibility
guild_provider_button_disabled_targets

TABLES 定義にもこれらが含まれている。

9.2 guild_provider_settings

provider/guild単位のscalar設定を保持する。

主キー:

provider_id + guild_id

最新コードでは多数のprovider出力制御カラムが追加されている。

Web側で扱う主なカラム

enabled
default_language
edit_original_if_translate
extract_bot_message
legacy_mode
passive_mode
anonymous_expand
secondary_extract_mode
secondary_extract_mode_multiple_images
secondary_extract_mode_video
send_media_as_attachments_as_default
delete_if_only_posted_tweet_link
delete_if_only_posted_tweet_link_secondary_extract_mode
always_reply_if_posted_tweet_link
quote_repost_max_depth
quote_repost_do_not_extract
pixiv_images_per_step
youtube_description_max_length
youtube_video_list_limit
tiktok_hq
twitter_text_mode
twitter_stats_layout
twitter_quote_mode
twitter_quote_layout
pixiv_caption_max_length
pixiv_tag_limit
instagram_caption_max_length
instagram_media_limit
github_card_style
hidden_output_items
display_density
media_display_mode
failure_display_policy
tiktok_description_max_length
tiktok_image_limit
tiktok_video_fallback_mode
niconico_description_max_length
spotify_description_max_length
twitch_description_max_length
steam_description_max_length
steam_image_source
amazon_description_max_length
booth_description_max_length
booth_image_limit
booth_adult_display_mode

9.3 Prismaモデル

Prisma schemaでは既存DBを正として定義する。

model GuildProviderSetting {
  providerId String @map("provider_id") @db.VarChar(64)
  guildId    String @map("guild_id") @db.VarChar(32)
  enabled Boolean? @db.TinyInt
  defaultLanguage String? @map("default_language") @db.VarChar(16)
  editOriginalIfTranslate Boolean? @map("edit_original_if_translate") @db.TinyInt
  extractBotMessage Boolean? @map("extract_bot_message") @db.TinyInt
  legacyMode Boolean? @map("legacy_mode") @db.TinyInt
  passiveMode Boolean? @map("passive_mode") @db.TinyInt
  anonymousExpand Boolean? @map("anonymous_expand") @db.TinyInt
  secondaryExtractMode Boolean? @map("secondary_extract_mode") @db.TinyInt
  secondaryExtractModeMultipleImages Boolean? @map("secondary_extract_mode_multiple_images") @db.TinyInt
  secondaryExtractModeVideo Boolean? @map("secondary_extract_mode_video") @db.TinyInt
  sendMediaAsAttachmentsAsDefault Boolean? @map("send_media_as_attachments_as_default") @db.TinyInt
  deleteIfOnlyPostedTweetLink Boolean? @map("delete_if_only_posted_tweet_link") @db.TinyInt
  deleteIfOnlyPostedTweetLinkSecondaryExtractMode Boolean? @map("delete_if_only_posted_tweet_link_secondary_extract_mode") @db.TinyInt
  alwaysReplyIfPostedTweetLink Boolean? @map("always_reply_if_posted_tweet_link") @db.TinyInt
  quoteRepostMaxDepth Int? @map("quote_repost_max_depth")
  quoteRepostDoNotExtract Boolean? @map("quote_repost_do_not_extract") @db.TinyInt
  pixivImagesPerStep Int? @map("pixiv_images_per_step")
  youtubeDescriptionMaxLength Int? @map("youtube_description_max_length")
  youtubeVideoListLimit Int? @map("youtube_video_list_limit")
  tiktokHq Boolean? @map("tiktok_hq") @db.TinyInt
  twitterTextMode String? @map("twitter_text_mode") @db.VarChar(32)
  twitterStatsLayout String? @map("twitter_stats_layout") @db.VarChar(32)
  twitterQuoteMode String? @map("twitter_quote_mode") @db.VarChar(32)
  twitterQuoteLayout String? @map("twitter_quote_layout") @db.VarChar(32)
  pixivCaptionMaxLength Int? @map("pixiv_caption_max_length")
  pixivTagLimit String? @map("pixiv_tag_limit") @db.VarChar(32)
  instagramCaptionMaxLength Int? @map("instagram_caption_max_length")
  instagramMediaLimit Int? @map("instagram_media_limit")
  githubCardStyle String? @map("github_card_style") @db.VarChar(32)
  hiddenOutputItems String? @map("hidden_output_items") @db.Text
  displayDensity String? @map("display_density") @db.VarChar(32)
  mediaDisplayMode String? @map("media_display_mode") @db.VarChar(32)
  failureDisplayPolicy String? @map("failure_display_policy") @db.VarChar(32)
  tiktokDescriptionMaxLength Int? @map("tiktok_description_max_length")
  tiktokImageLimit Int? @map("tiktok_image_limit")
  tiktokVideoFallbackMode String? @map("tiktok_video_fallback_mode") @db.VarChar(32)
  niconicoDescriptionMaxLength Int? @map("niconico_description_max_length")
  spotifyDescriptionMaxLength Int? @map("spotify_description_max_length")
  twitchDescriptionMaxLength Int? @map("twitch_description_max_length")
  steamDescriptionMaxLength Int? @map("steam_description_max_length")
  steamImageSource String? @map("steam_image_source") @db.VarChar(32)
  amazonDescriptionMaxLength Int? @map("amazon_description_max_length")
  boothDescriptionMaxLength Int? @map("booth_description_max_length")
  boothImageLimit Int? @map("booth_image_limit")
  boothAdultDisplayMode String? @map("booth_adult_display_mode") @db.VarChar(32)
  updatedAt DateTime @map("updated_at") @updatedAt
  @@id([providerId, guildId])
  @@map("guild_provider_settings")
}

注意:

* BooleanはMySQL上ではTINYINTとして扱われる
* hidden_output_items はTEXTにJSON配列として保存する
* 未設定はNULLにする
* デフォルト値はDBではなくBot側の PROVIDER_DEFAULTS / settingDefault に任せる

10. バリデーション仕様

10.1 Zod基本方針

保存前に必ずZodで検証する。

const snowflakeSchema = z.string().regex(/^\d{5,32}$/);
const targetsSchema = z.object({
  user: z.array(snowflakeSchema).default([]),
  channel: z.array(snowflakeSchema).default([]),
  role: z.array(snowflakeSchema).default([]),
});
const hiddenOutputItemsSchema = z.array(z.string().min(1).max(64)).default([]);
const displayDensitySchema = z.enum(["compact", "standard", "detail"]);
const mediaDisplayModeSchema = z.enum(["embed", "attachment", "thumbnail_only", "link_only"]);
const failureDisplayPolicySchema = z.enum(["silent", "source_link", "error_summary"]);

10.2 choice検証

choice設定は、SettingSpecの choices に存在する値だけ保存可能にする。

function createChoiceSchema(spec: SettingSpec) {
  const values = spec.choices?.map(choice => String(choice.value)) ?? [];
  return z.string().refine(value => values.includes(value));
}

parseValue がある場合は、保存前に変換する。

10.3 provider対応検証

以下は禁止。

- 未定義providerへの保存
- providerが持っていないsetting keyの保存
- twitter以外へのsavetweet保存
- outputItemsに存在しないhidden_output_itemsの保存
- choiceに存在しない値の保存
- 数値範囲外の保存
- 空文字のbannedWords保存
- targetsにsnowflake以外を保存

10.4 競合設定検証

legacy_mode と secondary_extract_mode

排他。

legacy_mode=true にする場合、secondary_extract_mode=falseにする
secondary_extract_mode=true にする場合、legacy_mode=falseにする

この排他制御は既存 /guisetting 側にも存在する。

Web側では保存前に確認ダイアログを出す。

11. API仕様

11.1 GET /api/me

ログイン中ユーザー情報を返す。

{
  "id": "123456789012345678",
  "username": "user",
  "globalName": "User",
  "avatarUrl": "https://cdn.discordapp.com/..."
}

11.2 GET /api/guilds

管理可能guild一覧を返す。

[
  {
    "guildId": "123",
    "name": "Server",
    "iconUrl": "https://...",
    "botInstalled": true,
    "canView": true,
    "canEdit": true,
    "permissions": {
      "administrator": false,
      "manageGuild": true,
      "manageChannels": true
    },
    "providerSummary": {
      "enabled": 3,
      "disabled": 8,
      "total": 11
    }
  }
]

11.3 GET /api/guilds/:guildId/catalog

guildに対して利用可能な設定カタログを返す。

{
  "providers": [
    {
      "providerId": "twitter",
      "label": "Twitter / X",
      "enabledByDefault": true,
      "settings": [
        {
          "key": "display_density",
          "kind": "choice",
          "label": { "ja": "Output density", "en": "Output density" },
          "choices": [
            { "label": { "en": "Compact", "ja": "Compact" }, "value": "compact" }
          ]
        }
      ]
    }
  ]
}

11.4 GET /api/guilds/:guildId/providers

provider一覧と状態を返す。

[
  {
    "providerId": "twitter",
    "label": "Twitter / X",
    "enabled": true,
    "enabledByDefault": true,
    "changedFromDefault": false,
    "settingCount": 19,
    "customizedSettingCount": 4,
    "warnings": []
  }
]

11.5 GET /api/guilds/:guildId/providers/:providerId/settings

provider別設定を返す。

レスポンスには以下を含める。

- setting spec
- effective value
- raw DB value
- default value
- customized flag
- validation status
- dependencies
- conflicts
- warnings

例:

{
  "providerId": "twitter",
  "settings": [
    {
      "key": "twitter_text_mode",
      "kind": "choice",
      "value": "normal",
      "rawValue": null,
      "defaultValue": "normal",
      "customized": false,
      "warnings": []
    }
  ]
}

11.6 PATCH /api/guilds/:guildId/providers/:providerId/settings

設定を保存する。

リクエスト:

{
  "changes": {
    "display_density": "compact",
    "media_display_mode": "thumbnail_only",
    "hidden_output_items": ["stats", "duration"]
  }
}

処理:

1. 認証確認
2. guild権限確認
3. provider存在確認
4. setting keyがproviderに属しているか確認
5. Zod検証
6. 現在値取得
7. 競合解決
8. DB transaction開始
9. settings保存
10. 監査ログ保存
11. transaction commit
12. 更新後のeffective settingsを返す

11.7 POST /api/guilds/:guildId/providers/:providerId/reset

provider設定をデフォルトに戻す。

対象:

- scalar設定はNULLに戻す
- bannedWordsは該当行削除
- disable targetsは該当行削除
- button visibilityは該当行削除
- button disabled targetsは該当行削除

UX:

* リセット前に差分一覧を表示
* 「このproviderだけ」か「全provider」かを明確に表示
* 復元用に監査ログへbefore_jsonを保存

11.8 POST /api/guilds/:guildId/providers/bulk

全providerへの一括操作。

対応:

- 全provider有効化
- 全provider無効化
- common設定の一括変更
- display_density一括変更
- media_display_mode一括変更
- failure_display_policy一括変更

UX:

* 影響するprovider数を表示
* 個別に除外するproviderを選べる
* 一括変更前に差分を表示
* 危険操作は確認テキスト入力を要求する

11.9 GET /api/guilds/:guildId/audit-logs

監査ログ取得。

フィルタ:

provider_id
setting_key
actor_user_id
action
date_from
date_to

UX:

* 設定差分を見やすく表示
* JSON diff表示
* 変更前へ戻すボタン
* 変更者のDiscord表示名を解決
* Bot/API/手動操作の区別

12. 監査ログ仕様

新規テーブルを追加する。

CREATE TABLE IF NOT EXISTS dashboard_audit_logs (
  audit_log_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  guild_id VARCHAR(32) NOT NULL,
  provider_id VARCHAR(64) NULL,
  setting_key VARCHAR(191) NULL,
  actor_user_id VARCHAR(32) NOT NULL,
  actor_username_snapshot VARCHAR(255) NULL,
  action VARCHAR(64) NOT NULL,
  before_json LONGTEXT NULL,
  after_json LONGTEXT NULL,
  request_id VARCHAR(64) NULL,
  ip_hash CHAR(64) NULL,
  user_agent_hash CHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_dashboard_audit_guild_time (guild_id, created_at),
  INDEX idx_dashboard_audit_actor_time (actor_user_id, created_at),
  INDEX idx_dashboard_audit_provider_time (provider_id, created_at),
  INDEX idx_dashboard_audit_setting_time (setting_key, created_at)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

保存対象:

provider enabled変更
scalar設定変更
targets変更
bannedWords変更
button visibility変更
hidden_output_items変更
一括変更
リセット
設定インポート
メディア配信設定変更

13. UI画面仕様

13.1 トップページ

目的:

* Botダッシュボードの入口
* Discordログイン
* Bot導入導線

表示:

- ロゴ
- Bot概要
- Discordでログイン
- Botを招待
- サポートリンク

13.2 サーバー一覧

UX条件:

- 最近使ったサーバーを上位に表示
- 検索できる
- 権限不足を分かりやすく表示
- Bot未導入サーバーに招待ボタンを出す
- 設定済み/未設定をバッジ表示
- provider有効数を表示

13.3 サーバー概要

表示:

- 有効provider
- 無効provider
- 最近の変更
- 注意すべき設定
- 出力モード概要
- 失敗時policy概要
- メディア配信状態

UX:

* 「まずここを設定」カード
* 「おすすめプリセット」カード
* 「最近変更された設定」カード
* 「問題がある可能性」カード

13.4 provider一覧

providerカード表示:

- provider名
- provider ID
- 有効/無効
- デフォルト状態
- 設定変更数
- 出力密度
- メディア表示モード
- 失敗時policy
- 警告

UX:

* provider名検索
* 有効のみ/無効のみフィルタ
* 設定変更ありのみフィルタ
* providerカテゴリ分類
* 一括操作
* providerごとに「おすすめ設定」ボタン

13.5 provider詳細

構成:

- 概要
- 基本設定
- 出力表示
- メディア
- ボタン
- 対象制御
- provider専用設定
- 高度な設定
- プレビュー
- 変更履歴

UX:

* 左側に設定カテゴリナビゲーション
* 右側にライブプレビュー
* 上部に未保存変更バー
* 保存前に差分表示
* 設定ごとに説明、デフォルト値、現在値、推奨値を表示
* 危険設定は折りたたみ
* 変更時に関連設定の影響を表示
* 検索結果に一致した設定だけを表示できる

13.6 出力プレビュー

目的:

* 設定変更後のBot出力を保存前にイメージできるようにする

対応:

- Twitter投稿
- Pixiv作品
- YouTube動画
- YouTubeプレイリスト
- YouTubeチャンネル
- Niconico動画
- Instagram投稿
- TikTok動画
- GitHubリポジトリ
- Steamアプリ
- Booth商品

MVPでは実API取得ではなく、fixtureベースの擬似プレビューでよい。

UX:

* compact / standard / detail比較
* embed / attachment / thumbnail_only / link_only比較
* hidden_output_items反映
* 説明文長さ反映
* ボタン表示反映
* 変更前/変更後比較

13.7 設定検索

検索対象:

- 設定キー
- 日本語ラベル
- 英語ラベル
- 説明文
- provider名
- DBカラム名

UX:

* 動画, メディア, 削除, 匿名, 失敗, 説明文, 引用, タグ などで検索できる
* 検索結果をprovider横断で表示
* 設定がどのproviderに属するか表示
* 検索結果から直接設定変更可能
* 検索結果にも危険度・影響範囲を表示

13.8 設定プリセット

プリセット例:

静かな運用

display_density = compact
failure_display_policy = silent
media_display_mode = thumbnail_only

情報量多め

display_density = detail
failure_display_policy = source_link
media_display_mode = embed

メディア重視

display_density = standard
media_display_mode = attachment
hidden_output_items = stats系を一部非表示

軽量運用

display_density = compact
media_display_mode = link_only
failure_display_policy = silent

管理者向け検証

display_density = detail
failure_display_policy = error_summary
media_display_mode = embed

UX:

* プリセット適用前に差分表示
* providerごとに適用範囲を選択
* 現在値との差分だけを保存
* プリセットから個別に微調整できる

13.9 設定診断

診断項目:

- providerが全て無効ではないか
- failure_display_policyがerror_summaryで通常チャンネルにノイズが出ないか
- media_display_mode=attachmentで大量メディアproviderがONになっていないか
- quote_repost_max_depth=0で引用が増えすぎないか
- legacy_modeとsecondary_extract_modeが競合していないか
- BotにManage Messages権限があるか
- delete source系設定がONなのにBot権限が不足していないか
- hidden_output_itemsで重要な安全表示を消していないか
- adult_display_modeがサーバールールと矛盾しないか

UX:

* 問題を「情報」「注意」「警告」「危険」に分類
* ワンクリック修正を用意
* 修正前に差分を表示
* 診断結果を管理者に共有できる

14. メディア配信サーバー統合要件

追加要件として、YouTubeやNiconicoのダウンロード済みメディアを配信するサーバーを統合する。

現在のコードでは youtubeDownloadServer がExpressで起動し、YouTubeとNiconicoの両方のdownload routeを扱っている。ready時に youtubeDownloadServer.start() が呼ばれている。
さらに、Expressサーバーは /youtube-downloads/:token/:filename と /niconico-downloads/:token/:filename の両方を処理している。

14.1 現状の問題

現状の名前は youtubeDownloadServer だが、実態としてはYouTubeとNiconicoの両方を配信している。

そのため、Webダッシュボード実装に合わせて、設計上は以下のように一般化する。

youtubeDownloadServer
↓
mediaDeliveryServer

14.2 統合対象

YouTube download cache
Niconico download cache
将来のTikTok/Instagram/その他メディアcache

14.3 配信サーバー要件

ルーティング

/media/youtube/:token/:filename
/media/niconico/:token/:filename

既存互換のため、当面は以下も維持する。

/youtube-downloads/:token/:filename
/niconico-downloads/:token/:filename

YouTube側は ROUTE_PREFIX = /youtube-downloads、Niconico側は ROUTE_PREFIX = /niconico-downloads を持つ。

設定

Webダッシュボードから以下を確認できるようにする。

- 配信サーバー稼働状態
- publicBaseUrl
- YouTube download dir
- Niconico download dir
- TTL
- 現在のキャッシュ数
- 現在のキャッシュ容量
- cleanup interval
- download button enabled

管理操作

- キャッシュ一覧表示
- 手動cleanup
- 特定tokenの削除
- 全期限切れ削除
- provider別キャッシュ削除
- 配信URLコピー
- ファイル存在確認

セキュリティ

- tokenは十分長いランダム文字列
- path traversal防止
- 期限切れは410
- 存在しないtokenは404
- Cache-Controlはno-store
- 管理APIは管理者のみ

現コードでもtoken検証、期限切れ410、path traversal防止、no-storeが実装されている。

UX

ダッシュボードに /dashboard/[guildId]/media を追加する。

表示:

- Media delivery server status
- Public base URL
- YouTube cache status
- Niconico cache status
- Expired cache count
- Total cache size
- Last cleanup time
- Recent download errors

操作:

- Cleanup expired files
- Open public URL
- Copy public URL
- Delete cache item
- Test delivery route

15. メディア配信設定

将来的にDB管理できるよう、以下の設定を追加できる設計にする。

media_delivery_enabled
media_delivery_public_base_url
media_delivery_ttl_ms
youtube_download_button_enabled
niconico_download_button_enabled
youtube_download_dir
niconico_download_dir
media_delivery_max_file_size_bytes
media_delivery_cleanup_interval_ms

ただし、MVPでは既存env/configの読み取り表示だけでもよい。

YouTube download storeは YOUTUBE_DOWNLOAD_DIR、YOUTUBE_DOWNLOAD_PUBLIC_BASE_URL、YOUTUBE_DOWNLOAD_TTL_MS、YOUTUBE_DOWNLOAD_BUTTON_ENABLED を参照できる。
Niconico download storeも NICONICO_DOWNLOAD_DIR、NICONICO_DOWNLOAD_PUBLIC_BASE_URL、NICONICO_DOWNLOAD_TTL_MS、NICONICO_DOWNLOAD_BUTTON_ENABLED を参照できる。

16. UX詳細条件

16.1 保存体験

- 変更すると画面上部に未保存バーを表示
- 保存前に差分を表示
- 保存成功時はtoast
- 保存失敗時は設定項目ごとにエラー表示
- 保存中は該当セクションをロック
- ページ離脱前に未保存警告
- セッション切れ時は下書き保存

16.2 差分表示

差分は以下を表示。

- 設定名
- 変更前
- 変更後
- デフォルト値
- 影響範囲
- 危険度

16.3 デフォルト表示

各設定に以下を表示。

- 現在の実効値
- DB保存値
- デフォルト値
- デフォルトから変更済みか

16.4 依存関係表示

例:

secondary_extract_mode がOFFなら secondary_extract_mode_video は影響しない
twitter_quote_mode=hiddenなら quote_repost_max_depth は影響が薄い
media_display_mode=link_onlyならメディアボタンは不要
failure_display_policy=silentならエラー概要は出ない

16.5 危険設定

危険設定は確認を出す。

- 全provider無効化
- quote_repost_max_depth=0
- media_display_mode=attachmentを全providerに適用
- adult_display_mode=normal
- error_summaryを全providerに適用
- hidden_output_itemsで安全・注意系表示を隠す
- delete source系設定

16.6 ヘルプ文

各設定には以下を持たせる。

- 何を変えるか
- いつ使うべきか
- 推奨値
- 注意点
- 関連設定
- 出力プレビュー

16.7 表示密度

UI自体にも表示密度を持たせる。

Beginner: 主要設定だけ
Standard: 通常設定
Advanced: 全設定
Developer: DB key / raw value / JSONも表示

16.8 設定カテゴリ

カテゴリ例:

基本
対象制御
出力表示
メディア
ボタン
翻訳
削除・抑制
失敗時動作
provider専用
高度な設定

16.9 provider横断ビュー

設定項目をprovider別だけでなく、機能別にも見せる。

例:

メディア表示モード一覧
説明文長さ一覧
失敗時policy一覧
匿名化設定一覧
削除設定一覧

これにより、大量provider環境でも設定しやすくする。

16.10 ロールアウト支援

設定変更を安全に反映するため、以下を設ける。

- まず1providerだけ変更
- 変更後にプレビュー確認
- その後全providerへ展開
- 問題があればワンクリック復元

17. 実装タスク

Phase 1: 基盤

- dashboardディレクトリ作成
- Next.js + TypeScript導入
- shadcn/ui導入
- Tailwind導入
- Prisma導入
- Discord OAuth2導入
- DB接続確認

Phase 2: 設定カタログ移植

- _setting_specs.js相当のカタログをdashboard側で読める形にする
- 可能なら共通パッケージ化する
- provider settings配列を解釈する
- common設定とprovider専用設定を合成する
- outputItems対応

推奨:

packages/settings-catalog を作り、BotとDashboardで共有する

ただし、BotがCommonJSなので最初はDashboard側に同期コピーでもよい。

Phase 3: DB読み書き

- getProviderSettings
- getSetting
- setSetting
- resetSetting
- setProviderEnabled
- setTargets
- setBannedWords
- setButtonVisibility
- setHiddenOutputItems

Bot側 _provider_settings.js と同じ意味になること。

Phase 4: UI MVP

- Discordログイン
- guild一覧
- provider一覧
- provider詳細
- 設定編集
- 保存
- 差分表示
- 監査ログ

Phase 5: UX強化

- 出力プレビュー
- 設定検索
- provider横断ビュー
- プリセット
- 設定診断
- 依存関係警告
- 危険設定確認
- 変更履歴から復元

Phase 6: メディア配信統合

- youtubeDownloadServerをmediaDeliveryServerへ改名またはラップ
- YouTube/Niconico routeを統一管理
- Dashboardにmedia管理画面追加
- cache状態表示
- cleanup操作
- 配信URLテスト

18. Codex向け実装指示

Codexに渡す場合は以下の方針で実装する。

既存Botの動作を壊さず、dashboard/配下にNext.jsベースのWebダッシュボードを追加してください。
ダッシュボードは既存MySQLを参照・更新し、Botの _provider_settings.js と互換性を保ってください。
設定項目は固定フォームとして実装せず、src/providers/_setting_specs.js の設計に合わせた設定カタログ駆動UIにしてください。
providerの settings 配列、common settings、SETTING_SPEC_CATALOG、outputItems をもとに、provider詳細画面を自動生成してください。
設定種類は providerEnabled / bool / choice / targets / buttonVisibility / bannedWords / outputVisibility に対応してください。
保存前にはZodで検証し、保存後はdashboard_audit_logsへ監査ログを残してください。
UXとして、設定検索、変更差分、デフォルト値表示、危険設定警告、依存関係警告、出力プレビューの土台を実装してください。
YouTubeとNiconicoのダウンロード済みメディア配信サーバーは、将来的にmediaDeliveryServerとして統合管理できるようにしてください。Dashboardにはmedia管理画面を追加し、既存のYouTube/Niconico download cache状態を確認できるようにしてください。

19. MVP完了条件

- dashboardが起動できる
- Discord OAuth2でログインできる
- 管理可能guildだけ表示される
- provider一覧が表示される
- provider別設定がカタログ駆動で表示される
- bool / choice / targets / buttonVisibility / bannedWords / outputVisibility を編集できる
- MySQLへ保存できる
- 保存後にBotが設定を読める
- 保存前にZod検証される
- 変更差分が表示される
- 監査ログが残る
- 既存Botのnpm start/test/lint/typecheckを壊さない
- YouTube/Niconicoメディア配信サーバー統合要件が設計に含まれている

20. 将来拡張

- provider追加時の自動UI生成
- settings catalogのnpm package化
- 出力プレビューのfixture管理
- 実URLを使ったテスト展開
- サーバー別プリセット
- provider別プリセット
- 設定テンプレート共有
- 設定のバージョン管理
- Webhook通知
- Slack/Discordへの設定変更通知
- メディア配信サーバーの統計表示
- エラー率・provider成功率ダッシュボード
- auto extract管理
- quota管理
