import "server-only";

import { DASHBOARD_LOCALE_OPTIONS } from "@/lib/discord-locales";
import { requireBotModule } from "@/lib/bot-require";
import type { LocaleText, ProviderCatalogItem, SettingKind, SettingSpec } from "@/lib/types";

type BotProvider = {
  id: string;
  name?: string;
  label?: string | { en?: string; ja?: string };
  enabledByDefault?: boolean;
  settings?: unknown[];
};

type BotSettingSpec = {
  key?: string;
  settingKey?: string;
  label?: LocaleText;
  description?: LocaleText;
  kind?: SettingKind;
  choices?: Array<{ label: LocaleText; value: string | number | boolean }>;
  outputItems?: Array<{ value: string; label: LocaleText; description?: LocaleText }>;
};

type BotLoader = {
  loadProviders: () => BotProvider[];
};

type BotSpecs = {
  getProviderSettingSpecs: (provider: BotProvider, options?: Record<string, unknown>) => BotSettingSpec[];
};

type BotProviderSettings = {
  PROVIDER_DEFAULTS: Record<string, unknown>;
  PROVIDER_SETTING_COLUMNS: Record<string, { column: string; type: "bool" | "int" | "string" | "jsonArray" | "jsonObject" }>;
};

const PROVIDER_LABELS: Record<string, string> = {
  amazon: "Amazon",
  booth: "Booth",
  github: "GitHub",
  instagram: "Instagram",
  niconico: "Niconico",
  pixiv: "Pixiv",
  spotify: "Spotify",
  steam: "Steam",
  tiktok: "TikTok",
  twitch: "Twitch",
  twitter: "Twitter / X",
  youtube: "YouTube",
};

const PROVIDER_DOMAINS: Record<string, string> = {
  amazon: "amazon.*",
  booth: "booth.pm",
  github: "github.com",
  instagram: "instagram.com",
  niconico: "nicovideo.jp",
  pixiv: "pixiv.net",
  spotify: "open.spotify.com",
  steam: "store.steampowered.com",
  tiktok: "tiktok.com",
  twitch: "twitch.tv",
  twitter: "x.com / twitter.com",
  youtube: "youtube.com / youtu.be",
};

const PROVIDER_DISPLAY_NAMES: Record<string, { ja: string; en: string }> = {
  amazon: { ja: "Amazon", en: "Amazon" },
  booth: { ja: "Booth", en: "Booth" },
  github: { ja: "GitHub", en: "GitHub" },
  instagram: { ja: "Instagram", en: "Instagram" },
  niconico: { ja: "Niconico", en: "Niconico" },
  pixiv: { ja: "Pixiv", en: "Pixiv" },
  spotify: { ja: "Spotify", en: "Spotify" },
  steam: { ja: "Steam", en: "Steam" },
  tiktok: { ja: "TikTok", en: "TikTok" },
  twitch: { ja: "Twitch", en: "Twitch" },
  twitter: { ja: "Twitter / X", en: "Twitter / X" },
  youtube: { ja: "YouTube", en: "YouTube" },
};

const TWITTER_ACCOUNT_DEPTH_SPEC: BotSettingSpec = {
  key: "quote_repost_depth_by_account",
  settingKey: "quote_repost_depth_by_account",
  label: {
    ja: "Twitter/X アカウント別引用RT展開数",
    en: "Twitter account quote depth",
  },
  description: {
    ja: "アカウントごとに引用RTの展開数を上書きします。/et で account を指定した場合もここへ保存されます。",
    en: "Per-account quote repost expansion depth. Account overrides are also saved by /et when account is set.",
  },
  kind: "accountDepthMap",
};

const SETTING_TEXT_OVERRIDES: Record<string, { label?: LocaleText; description?: LocaleText; choices?: Record<string, LocaleText> }> = {
  enabled: {
    label: { ja: "プロバイダーを有効化", en: "Enable provider" },
    description: { ja: "このサーバーで、このサービスのリンクを展開するかを切り替えます。", en: "Controls whether this provider expands links in this server." },
  },
  disable: {
    label: { ja: "対象ごとの展開停止", en: "Disable expansion by target" },
    description: { ja: "指定したユーザー、チャンネル、ロールではリンク展開を行いません。", en: "Stops link expansion for selected users, channels, or roles." },
  },
  defaultLanguage: {
    label: { ja: "標準の表示言語", en: "Default display language" },
    description: { ja: "対応している表示文言や翻訳結果の標準言語を選びます。", en: "Chooses the default language for supported labels and translation output." },
    choices: {
      en: { ja: "英語", en: "English" },
      ja: { ja: "日本語", en: "Japanese" },
    },
  },
  editOriginalIfTranslate: {
    label: { ja: "翻訳後に元の応答を編集", en: "Edit original response after translation" },
    description: { ja: "翻訳ボタンが押されたとき、別メッセージではなく元のBot応答を置き換えます。", en: "Edits the original bot response instead of posting a separate translated message." },
  },
  extract_bot_message: {
    label: { ja: "BotやWebhookの投稿も展開", en: "Expand bot and webhook messages" },
    description: { ja: "BotやWebhookが投稿したリンクも展開対象にします。", en: "Also expands provider links posted by bots or webhooks." },
  },
  button_invisible: {
    label: { ja: "応答ボタンを非表示", en: "Hide response buttons" },
    description: { ja: "Bot応答に付く翻訳、削除、メディア切り替えなどのボタンを非表示にします。", en: "Hides translate, delete, media switch, and other response buttons." },
  },
  button_disabled: {
    label: { ja: "対象ごとのボタン操作停止", en: "Disable button use by target" },
    description: { ja: "指定したユーザー、チャンネル、ロールではBot応答のボタン操作を止めます。", en: "Prevents selected users, channels, or roles from using response buttons." },
  },
  failure_display_policy: {
    label: { ja: "取得失敗時の表示", en: "Fetch failure output" },
    description: { ja: "リンク情報を取得できなかったときにBotが何を送るかを選びます。", en: "Chooses what the bot sends when provider metadata cannot be fetched." },
    choices: {
      silent: { ja: "何も送らない", en: "Send nothing" },
      source_link: { ja: "元リンクだけ送る", en: "Send source link" },
      error_summary: { ja: "短いエラー概要を送る", en: "Send a short error summary" },
    },
  },
  bannedWords: {
    label: { ja: "展開しないワード", en: "Banned words" },
    description: { ja: "取得したタイトル、本文、キャプション、説明文に登録ワードが含まれる場合、そのリンク展開を送信しません。", en: "Skips expansion when fetched text contains a registered word." },
  },
  anonymous_expand: {
    label: { ja: "展開者名を隠す", en: "Hide requester name" },
    description: { ja: "埋め込みに表示される展開リクエスト者名を匿名表示に置き換えます。", en: "Replaces the requester name shown in embeds with an anonymous label." },
  },
  alwaysreplyifpostedtweetlink: {
    label: { ja: "元投稿への返信として送信", en: "Reply to source message" },
    description: { ja: "展開結果を通常投稿ではなく、元メッセージへのDiscord返信として送信します。", en: "Sends expansion output as a Discord reply to the source message." },
  },
  deletemessageifonlypostedtweetlink: {
    label: { ja: "リンクだけの元投稿を削除", en: "Delete source message when it only contains a link" },
    description: { ja: "投稿内容がリンクだけだった場合、展開後に元のユーザーメッセージを削除します。", en: "Deletes the original user message after expansion when it only contained the provider link." },
  },
  deletemessageifonlypostedtweetlink_secoundaryextractmode: {
    label: { ja: "secondary extract時も元投稿を削除", en: "Delete source message in secondary extract mode" },
    description: { ja: "secondary extract modeで展開した場合も、リンクだけの元投稿を削除します。", en: "Also deletes link-only source messages when secondary extract mode expands them." },
  },
  suppress_source_embeds_if_only_posted_tweet_link_secondary_extract_mode: {
    label: { ja: "セカンダリ展開時の元リンクプレビュー抑制", en: "Suppress source preview in secondary extract mode" },
    description: { ja: "secondary extract modeで条件に合うツイートを展開したとき、元投稿がリンクのみならDiscord標準リンクプレビューを抑制します。", en: "Suppresses Discord's built-in link preview for link-only source messages when secondary extract mode expands a matching tweet." },
  },
  display_density: {
    label: { ja: "出力密度", en: "Output density" },
    description: { ja: "埋め込みに含める情報量を選びます。", en: "Chooses how much optional metadata this provider includes in embeds." },
    choices: {
      compact: { ja: "コンパクト", en: "Compact" },
      standard: { ja: "標準", en: "Standard" },
      detail: { ja: "詳細", en: "Detail" },
    },
  },
  media_display_mode: {
    label: { ja: "メディア表示", en: "Media display mode" },
    description: { ja: "画像や動画をEmbed、添付、サムネイル、リンクのみのどれで表示するかを選びます。", en: "Chooses whether media is shown as embeds, attachments, thumbnails, or links only." },
    choices: {
      embed: { ja: "Embedで表示", en: "Embed media" },
      attachment: { ja: "添付ファイルで送信", en: "Attachments" },
      thumbnail_only: { ja: "サムネイルのみ", en: "Thumbnail only" },
      link_only: { ja: "リンクのみ", en: "Links only" },
    },
  },
  hidden_output_items: {
    label: { ja: "非表示にする出力項目", en: "Hidden output items" },
    description: { ja: "埋め込みに出る項目を選んで非表示にします。応答ボタンの非表示とは別です。", en: "Hides selected embed fields or content blocks. This is separate from button visibility." },
  },
  amazon_description_max_length: {
    label: { ja: "Amazon説明文の長さ", en: "Amazon description length" },
    description: { ja: "Amazon埋め込みで表示する説明文の最大文字数です。0にすると説明文を隠します。", en: "Maximum Amazon embed description length. 0 hides descriptions." },
  },
  booth_adult_display_mode: {
    label: { ja: "成人向けBooth商品の表示", en: "Adult Booth media display" },
    description: { ja: "成人向けBooth商品のメディアを通常表示、メタ情報のみ、spoiler添付、展開しないのどれで扱うかを選びます。", en: "Chooses whether adult Booth item media is shown normally, metadata-only, as spoiler attachments, or not expanded." },
    choices: {
      normal: { ja: "通常表示", en: "Normal display" },
      metadata_only: { ja: "メタ情報のみ", en: "Metadata only" },
      spoiler_attachment: { ja: "spoiler添付", en: "Spoiler attachments" },
      suppress: { ja: "展開しない", en: "Suppress expansion" },
    },
  },
  github_card_style: {
    label: { ja: "GitHubカード表示", en: "GitHub card style" },
    description: { ja: "Bot生成カードとGitHub公式OGPカードのどちらで表示するかを選びます。", en: "Chooses between generated bot cards and GitHub's official OGP card." },
    choices: {
      generated: { ja: "Bot生成カード", en: "Generated card" },
      github: { ja: "GitHub公式カード", en: "GitHub card" },
    },
  },
  steam_image_source: {
    label: { ja: "Steam画像ソース", en: "Steam image source" },
    description: { ja: "Steam埋め込みに使う画像の種類を選びます。", en: "Chooses which Steam image is used in embeds." },
    choices: {
      header: { ja: "ヘッダー画像", en: "Header image" },
      screenshot: { ja: "スクリーンショット", en: "Screenshot" },
      thumbnail: { ja: "サムネイル", en: "Thumbnail" },
    },
  },
  sendMediaAsAttachmentsAsDefault: {
    label: { ja: "メディアを添付ファイル優先で送信", en: "Prefer media attachments" },
    description: { ja: "対応サービスで、画像や動画をEmbed画像ではなくDiscord添付ファイルとして優先送信します。", en: "Prefers Discord attachments over embed media where supported." },
  },
  legacy_mode: {
    label: { ja: "元リンクのプレビューを抑制", en: "Suppress source link preview" },
    description: { ja: "可能な場合、元メッセージに出るDiscord標準リンクプレビューを抑制します。", en: "Suppresses Discord's native preview on the source message when possible." },
  },
  passive_mode: {
    label: { ja: "Twitter出力を簡易表示", en: "Simplified Twitter output" },
    description: { ja: "Twitter/Xの本文情報を抑え、メディア操作中心の簡易出力にします。", en: "Uses a simpler Twitter/X output focused on media controls." },
  },
  twitter_stats_layout: {
    label: { ja: "Twitter統計の表示", en: "Twitter stats layout" },
    description: { ja: "返信、リポスト、いいね数を本文内、フィールド、非表示のどれで出すかを選びます。", en: "Chooses whether reply, repost, and like counts appear in the description, fields, or are hidden." },
    choices: {
      description: { ja: "本文内に表示", en: "Description line" },
      fields: { ja: "フィールドで表示", en: "Embed fields" },
      hidden: { ja: "表示しない", en: "Hidden" },
    },
  },
  twitter_quote_mode: {
    label: { ja: "引用ツイートの表示", en: "Quoted tweet display" },
    description: { ja: "引用ツイートを完全表示、短い要約、非表示のどれで扱うかを選びます。", en: "Chooses whether quoted Twitter/X posts are shown fully, summarized, or hidden." },
    choices: {
      full: { ja: "完全表示", en: "Full embed" },
      summary: { ja: "短い要約", en: "Short summary" },
      hidden: { ja: "表示しない", en: "Hidden" },
    },
  },
  pixiv_images_per_step: {
    label: { ja: "Pixiv画像の表示枚数", en: "Pixiv images per response" },
    description: { ja: "Pixiv作品を1回のBot応答に何枚まで含めるかを選びます。", en: "Chooses how many Pixiv images are included in one bot response." },
  },
  pixiv_caption_max_length: {
    label: { ja: "Pixiv説明文の長さ", en: "Pixiv caption length" },
    description: { ja: "Pixiv作品の説明文を何文字まで表示するかを選びます。0にすると説明文を隠します。", en: "Chooses the maximum Pixiv caption length. 0 hides captions." },
  },
  pixiv_tag_limit: {
    label: { ja: "Pixivタグ表示数", en: "Pixiv tag count" },
    description: { ja: "Pixiv作品のタグをいくつ表示するかを選びます。", en: "Chooses how many Pixiv tags are shown." },
  },
  youtube_video_list_limit: {
    label: { ja: "YouTube動画リスト件数", en: "YouTube video list count" },
    description: { ja: "プレイリストやチャンネル埋め込みで表示する動画リストの件数を選びます。0にすると非表示です。", en: "Chooses how many playlist or channel videos are listed. 0 hides the list." },
  },
  tiktok_hq: {
    label: { ja: "TikTok動画を高画質優先", en: "Prefer high-quality TikTok video" },
    description: { ja: "TikTok動画を添付ファイルとして送るとき、可能なら高画質ソースを優先します。", en: "Prefers a higher-quality TikTok video source when sending attachments." },
  },
  tiktok_video_fallback_mode: {
    label: { ja: "TikTok動画を添付できない時の表示", en: "TikTok video attachment fallback" },
    description: { ja: "TikTok動画を添付できない場合に、動画URL、サムネイルのみ、追加表示なしのどれにするかを選びます。", en: "Chooses what to show when a TikTok video cannot be attached." },
    choices: {
      video_url: { ja: "動画URLを表示", en: "Show video URL" },
      thumbnail_only: { ja: "サムネイルのみ", en: "Thumbnail only" },
      silent: { ja: "追加表示なし", en: "Send nothing extra" },
    },
  },
};

const OUTPUT_ITEM_LABELS: Record<string, LocaleText> = {
  article_card: { ja: "記事カード", en: "Article card" },
  article_title: { ja: "記事タイトル", en: "Article title" },
  article_preview: { ja: "記事プレビュー", en: "Article preview" },
  article_image: { ja: "記事画像", en: "Article image" },
  media_count: { ja: "メディア数", en: "Media count" },
  media_type: { ja: "メディア種別", en: "Media type" },
  sensitive_media: { ja: "センシティブ表示", en: "Sensitive media label" },
  stats: { ja: "統計情報", en: "Stats" },
  ai: { ja: "AI生成ラベル", en: "AI label" },
  maturity: { ja: "年齢レーティング", en: "Maturity rating" },
  type: { ja: "種類", en: "Type" },
  ugoira_media: { ja: "うごイラ情報", en: "Ugoira media" },
  pages: { ja: "ページ数", en: "Page count" },
  tags: { ja: "タグ", en: "Tags" },
  duration: { ja: "再生時間", en: "Duration" },
  uploaded: { ja: "投稿日", en: "Upload date" },
  video_list: { ja: "動画リスト", en: "Video list" },
  views: { ja: "再生数", en: "Views" },
  comments: { ja: "コメント数", en: "Comments" },
  mylists: { ja: "マイリスト数", en: "Mylists" },
  likes: { ja: "いいね数", en: "Likes" },
  series: { ja: "シリーズ", en: "Series" },
  owner: { ja: "投稿者", en: "Owner" },
  uploader: { ja: "アップロード者", en: "Uploader" },
  genre: { ja: "ジャンル", en: "Genre" },
  album: { ja: "アルバム", en: "Album" },
  artist: { ja: "アーティスト", en: "Artist" },
  brand: { ja: "ブランド", en: "Brand" },
  seller: { ja: "販売元", en: "Seller" },
  shipping: { ja: "配送", en: "Shipping" },
  review_count: { ja: "レビュー数", en: "Review count" },
  coupon: { ja: "クーポン", en: "Coupon" },
  deal: { ja: "セール", en: "Deal" },
  date: { ja: "日付", en: "Date" },
  cast: { ja: "出演者", en: "Cast" },
  season: { ja: "シーズン", en: "Season" },
  year: { ja: "年", en: "Year" },
  price: { ja: "価格", en: "Price" },
  rating: { ja: "評価", en: "Rating" },
  availability: { ja: "在庫/配信状況", en: "Availability" },
  id: { ja: "ID", en: "ID" },
  status: { ja: "状態", en: "Status" },
  price_range: { ja: "価格範囲", en: "Price range" },
  category: { ja: "カテゴリ", en: "Category" },
  image_count: { ja: "画像枚数", en: "Image count" },
  variations: { ja: "バリエーション", en: "Variations" },
  sale_period: { ja: "販売期間", en: "Sale period" },
  license: { ja: "ライセンス", en: "License" },
  state: { ja: "状態", en: "State" },
  mergeable: { ja: "マージ可否", en: "Mergeable" },
  review_state: { ja: "レビュー状態", en: "Review state" },
  checks: { ja: "Checks", en: "Checks" },
  labels: { ja: "ラベル", en: "Labels" },
  assignees: { ja: "担当者", en: "Assignees" },
  changes: { ja: "変更量", en: "Changes" },
  commits: { ja: "コミット", en: "Commits" },
  files: { ja: "ファイル", en: "Files" },
  sha: { ja: "SHA", en: "SHA" },
  author: { ja: "作成者", en: "Author" },
  tag: { ja: "タグ", en: "Tag" },
  assets: { ja: "アセット", en: "Assets" },
  size: { ja: "サイズ", en: "Size" },
  snippet: { ja: "ファイル内容プレビュー", en: "File snippet" },
  repositories: { ja: "リポジトリ", en: "Repositories" },
  followers: { ja: "フォロワー", en: "Followers" },
  location: { ja: "場所", en: "Location" },
  contributions: { ja: "コントリビューション", en: "Contributions" },
  gist_files: { ja: "Gistファイル", en: "Gist files" },
  language_breakdown: { ja: "言語内訳", en: "Language breakdown" },
  topics: { ja: "トピック", en: "Topics" },
  default_branch: { ja: "デフォルトブランチ", en: "Default branch" },
  last_push: { ja: "最終push", en: "Last push" },
  repo_card: { ja: "リポジトリカード画像", en: "Repository card image" },
  language: { ja: "言語", en: "Language" },
  repo_stats: { ja: "スター/フォーク/Issue", en: "Stars / forks / issues" },
  hashtags: { ja: "ハッシュタグ", en: "Hashtags" },
  mentions: { ja: "メンション", en: "Mentions" },
  audio: { ja: "音源", en: "Audio" },
  profile_status: { ja: "プロフィール状態", en: "Profile status" },
  media_range: { ja: "メディア枚数", en: "Media count" },
  profile_counts: { ja: "プロフィール数値", en: "Profile counts" },
  discount: { ja: "割引", en: "Discount" },
  sale_ends: { ja: "セール終了", en: "Sale ends" },
  metacritic: { ja: "Metacritic", en: "Metacritic" },
  release_date: { ja: "発売日", en: "Release date" },
  developer: { ja: "開発元", en: "Developer" },
  publisher: { ja: "パブリッシャー", en: "Publisher" },
  genres: { ja: "ジャンル", en: "Genres" },
  platforms: { ja: "対応OS", en: "Platforms" },
  recommendations: { ja: "レビュー/おすすめ数", en: "Recommendations" },
  current_players: { ja: "現在のプレイヤー数", en: "Current players" },
  review_summary: { ja: "レビュー概要", en: "Review summary" },
  music: { ja: "楽曲", en: "Music" },
  website: { ja: "Webサイト", en: "Website" },
  tracks: { ja: "曲数", en: "Track count" },
  total_duration: { ja: "合計再生時間", en: "Total duration" },
  track_number: { ja: "トラック番号", en: "Track number" },
  explicit: { ja: "Explicit表示", en: "Explicit label" },
  preview: { ja: "試聴プレビュー", en: "Preview" },
  top_tracks: { ja: "人気曲", en: "Top tracks" },
  game: { ja: "ゲーム", en: "Game" },
  clipped_by: { ja: "クリップ作成者", en: "Clipped by" },
  viewers: { ja: "視聴者数", en: "Viewers" },
  started: { ja: "配信開始", en: "Started" },
};

let providerCache: BotProvider[] | null = null;

export function getBotProviders() {
  if (providerCache) return providerCache;
  const loader = requireBotModule<BotLoader>("src/providers/_loader.js");
  providerCache = loader.loadProviders().slice().sort((a, b) => a.id.localeCompare(b.id));
  return providerCache;
}

export function getProvider(providerId: string) {
  return getBotProviders().find((provider) => provider.id === providerId) || null;
}

export function providerLabel(provider: Pick<BotProvider, "id" | "label" | "name">) {
  if (typeof provider.label === "string" && provider.label.trim()) return provider.label.trim();
  if (provider.label && typeof provider.label === "object") return provider.label.en || provider.label.ja || provider.id;
  if (provider.name) return provider.name;
  return PROVIDER_LABELS[provider.id] || provider.id.replace(/(^|[-_])(\w)/g, (_, prefix: string, ch: string) => `${prefix ? " " : ""}${ch.toUpperCase()}`);
}

export function providerDomain(providerId: string) {
  return PROVIDER_DOMAINS[providerId] || providerId;
}

function textValue(value: LocaleText | undefined, fallback: string): LocaleText {
  if (!value) return { en: fallback, ja: fallback };
  if (typeof value === "string") return value;
  return {
    ...value,
    en: value.en || value.ja || fallback,
    ja: value.ja || value.en || fallback,
  };
}

function providerNameForKey(key: string) {
  const providerId = key.split("_")[0];
  return PROVIDER_DISPLAY_NAMES[providerId] || { ja: providerId, en: providerId };
}

function generatedSettingTextOverride(key: string): { label?: LocaleText; description?: LocaleText } | undefined {
  const providerName = providerNameForKey(key);
  if (key.endsWith("_description_max_length")) {
    return {
      label: { ja: `${providerName.ja}説明文の長さ`, en: `${providerName.en} description length` },
      description: {
        ja: `${providerName.ja}埋め込みで表示する説明文の最大文字数です。0にすると説明文を隠します。`,
        en: `Maximum ${providerName.en} embed description length. 0 hides descriptions.`,
      },
    };
  }
  if (key.endsWith("_caption_max_length")) {
    return {
      label: { ja: `${providerName.ja}キャプションの長さ`, en: `${providerName.en} caption length` },
      description: {
        ja: `${providerName.ja}埋め込みで表示するキャプションの最大文字数です。0にするとキャプションを隠します。`,
        en: `Maximum ${providerName.en} caption length. 0 hides captions.`,
      },
    };
  }
  if (key.endsWith("_image_limit") || key.endsWith("_media_limit")) {
    return {
      label: { ja: `${providerName.ja}メディア表示数`, en: `${providerName.en} media count` },
      description: {
        ja: `${providerName.ja}埋め込みで表示する画像や動画の最大数を選びます。`,
        en: `Chooses how many ${providerName.en} media items are shown.`,
      },
    };
  }
  return undefined;
}

function choiceLabelFor(key: string, choice: { label: LocaleText; value: string | number | boolean }) {
  const value = String(choice.value);
  const override = SETTING_TEXT_OVERRIDES[key]?.choices?.[value];
  if (override) return override;

  if (key.includes("description_max_length") || key.includes("caption_max_length")) {
    return value === "0"
      ? { ja: "説明文を表示しない", en: "Hide description" }
      : { ja: `${value}文字`, en: `${value} characters` };
  }
  if (key.includes("image_limit") || key.includes("media_limit")) {
    return { ja: `${value}件まで表示`, en: `Show up to ${value}` };
  }
  if (key === "youtube_video_list_limit") {
    return value === "0"
      ? { ja: "動画リストを表示しない", en: "Hide video list" }
      : { ja: `${value}件表示`, en: `Show ${value}` };
  }
  if (key === "pixiv_images_per_step") {
    return { ja: `${value}枚`, en: `${value} images` };
  }
  if (key === "pixiv_tag_limit") {
    if (value === "0") return { ja: "タグを表示しない", en: "Hide tags" };
    if (value === "all") return { ja: "すべて表示", en: "Show all" };
    return { ja: `${value}個表示`, en: `Show ${value}` };
  }
  if (key === "quote_repost_max_depth") {
    return value === "0"
      ? { ja: "無制限", en: "Unlimited" }
      : { ja: `${value}段まで`, en: `Up to ${value}` };
  }
  return choice.label;
}

function outputItemLabelFor(item: { value: string; label: LocaleText }) {
  return OUTPUT_ITEM_LABELS[item.value] || item.label;
}

function choicesForSpec(key: string, spec: BotSettingSpec) {
  if (key === "defaultLanguage") {
    return DASHBOARD_LOCALE_OPTIONS.map((option) => ({
      label: `${option.flag} ${option.nativeName}`,
      value: option.value,
    }));
  }

  return spec.choices?.map((choice) => ({
    label: textValue(choiceLabelFor(key, choice), String(choice.value)),
    value: String(choice.value),
  }));
}

function categoryFor(spec: BotSettingSpec) {
  const key = spec.key || spec.settingKey || "";
  if (spec.kind === "providerEnabled") return "basic";
  if (spec.kind === "targets") return "targetControl";
  if (spec.kind === "buttonVisibility") return "buttons";
  if (spec.kind === "bannedWords") return "suppression";
  if (spec.kind === "outputVisibility") return "advanced";
  if (spec.kind === "multiChoice") return "provider";
  if (spec.kind === "accountDepthMap") return "advanced";
  if (key.includes("language") || key.includes("translate")) return "translation";
  if (key.includes("media") || key.includes("image") || key.includes("attachment") || key.includes("download") || key.includes("sensitive") || key.includes("r18")) return "media";
  if (key.includes("delete") || key.includes("legacy") || key.includes("passive") || key.includes("banned")) return "suppression";
  if (key.includes("failure") || key.includes("fallback")) return "failure";
  if (key.includes("density") || key.includes("description") || key.includes("caption") || key.includes("text") || key.includes("layout") || key.includes("stats")) return "output";
  return "provider";
}

function impactFor(spec: BotSettingSpec) {
  const key = spec.key || spec.settingKey || "";
  if (spec.kind === "accountDepthMap") return "high" as const;
  if (
    key.includes("adult_display_mode") ||
    key.includes("sensitive_display_mode") ||
    key.includes("r18_display_mode") ||
    key.includes("r18g_display_mode") ||
    key.includes("quote_repost_max_depth") ||
    key.includes("delete_if_only") ||
    key.includes("deletemessage") ||
    key === "extract_bot_message"
  ) {
    return "danger" as const;
  }
  if (key.includes("attachment") || key.includes("media_display_mode") || key.includes("failure_display_policy") || key.includes("legacy") || key.includes("secondary")) {
    return "high" as const;
  }
  if (spec.kind === "targets" || spec.kind === "buttonVisibility" || spec.kind === "outputVisibility" || spec.kind === "multiChoice") return "medium" as const;
  return "low" as const;
}

function dependenciesFor(spec: BotSettingSpec) {
  const key = spec.key || spec.settingKey || "";
  if (
    key === "secondary_extract_mode_multiple_images"
    || key === "secondary_extract_mode_video"
    || key === "deletemessageifonlypostedtweetlink_secoundaryextractmode"
    || key === "suppress_source_embeds_if_only_posted_tweet_link_secondary_extract_mode"
  ) {
    return ["secondary_extract_mode"];
  }
  if (key === "quote_repost_max_depth") return ["twitter_quote_mode", "quote_repost_do_not_extract"];
  if (key === "quote_repost_depth_by_account") return ["twitter_quote_mode"];
  return [];
}

function conflictsFor(spec: BotSettingSpec) {
  const key = spec.key || spec.settingKey || "";
  if (key === "legacy_mode") return ["secondary_extract_mode"];
  if (key === "secondary_extract_mode") return ["legacy_mode"];
  if (key === "quote_repost_do_not_extract") return ["twitter_quote_mode", "quote_repost_max_depth"];
  return [];
}

function isAdvanced(spec: BotSettingSpec) {
  const key = spec.key || spec.settingKey || "";
  return (
    spec.kind === "outputVisibility" ||
    spec.kind === "accountDepthMap" ||
    key.includes("sensitive_content_") ||
    key.includes("sensitive_restriction") ||
    key.includes("legacy") ||
    key.includes("secondary") ||
    key.includes("fallback") ||
    key.includes("quote_repost") ||
    key.includes("adult_display_mode") ||
    key.includes("sensitive_display_mode") ||
    key.includes("r18_display_mode") ||
    key.includes("r18g_display_mode")
  );
}

function serializeSpec(spec: BotSettingSpec): SettingSpec | null {
  const key = spec.key || spec.settingKey;
  if (!key || !spec.kind) return null;
  const columns = getProviderSettingColumns();
  const override = SETTING_TEXT_OVERRIDES[key] || generatedSettingTextOverride(key);
  return {
    key,
    settingKey: spec.settingKey || key,
    label: textValue(override?.label || spec.label, key),
    description: textValue(override?.description || spec.description, key),
    kind: spec.kind,
    choices: choicesForSpec(key, spec),
    outputItems: spec.outputItems?.map((item) => ({
      value: item.value,
      label: textValue(outputItemLabelFor(item), item.value),
      description: item.description ? textValue(item.description, item.value) : undefined,
    })),
    category: categoryFor(spec),
    impactLevel: impactFor(spec),
    recommended: ["enabled", "display_density", "media_display_mode", "failure_display_policy"].includes(key),
    advanced: isAdvanced(spec),
    dependencies: dependenciesFor(spec),
    conflicts: conflictsFor(spec),
    dbColumn: columns[key]?.column || specialSettingDbTarget(key),
  };
}

function specialSettingDbTarget(key: string) {
  if (key === "disable") return "guild_provider_disable_targets";
  if (key === "sensitive_content_allowed_targets") return "guild_provider_sensitive_content_allowed_targets";
  if (key === "sensitive_content_excluded_targets") return "guild_provider_sensitive_content_excluded_targets";
  if (key === "pixiv_r18_sensitive_content_allowed_targets") return "guild_provider_pixiv_r18_sensitive_content_allowed_targets";
  if (key === "pixiv_r18_sensitive_content_excluded_targets") return "guild_provider_pixiv_r18_sensitive_content_excluded_targets";
  if (key === "pixiv_r18g_sensitive_content_allowed_targets") return "guild_provider_pixiv_r18g_sensitive_content_allowed_targets";
  if (key === "pixiv_r18g_sensitive_content_excluded_targets") return "guild_provider_pixiv_r18g_sensitive_content_excluded_targets";
  if (key === "button_disabled") return "guild_provider_button_disabled_targets";
  if (key === "button_invisible") return "guild_provider_button_visibility";
  if (key === "bannedWords") return "guild_provider_banned_words";
  return null;
}

export function getProviderSettingColumns() {
  return requireBotModule<BotProviderSettings>("src/providers/_provider_settings.js").PROVIDER_SETTING_COLUMNS;
}

export function getProviderDefaults() {
  return requireBotModule<BotProviderSettings>("src/providers/_provider_settings.js").PROVIDER_DEFAULTS;
}

export function getProviderSpecs(provider: BotProvider, options: { includeOverview?: boolean; includeCommon?: boolean } = {}) {
  const specsModule = requireBotModule<BotSpecs>("src/providers/_setting_specs.js");
  const specs = specsModule
    .getProviderSettingSpecs(provider, options)
    .map(serializeSpec)
    .filter((spec): spec is SettingSpec => Boolean(spec));
  if (provider.id === "twitter" && !specs.some((spec) => spec.key === TWITTER_ACCOUNT_DEPTH_SPEC.key)) {
    const spec = serializeSpec(TWITTER_ACCOUNT_DEPTH_SPEC);
    if (spec) specs.push(spec);
  }
  return specs;
}

export function getCatalog(): ProviderCatalogItem[] {
  return getBotProviders().map((provider) => ({
    providerId: provider.id,
    label: providerLabel(provider),
    enabledByDefault: provider.enabledByDefault === true,
    settings: getProviderSpecs(provider),
  }));
}

export function getProviderCatalog(providerId: string) {
  const provider = getProvider(providerId);
  if (!provider) return null;
  return {
    providerId: provider.id,
    label: providerLabel(provider),
    enabledByDefault: provider.enabledByDefault === true,
    settings: getProviderSpecs(provider),
  };
}

export function text(localeText: LocaleText, locale: "en" | "ja" = "en") {
  if (typeof localeText === "string") return localeText;
  return localeText[locale] || localeText.en || localeText.ja || "";
}

export function editableSpecs(providerId: string) {
  const provider = getProvider(providerId);
  if (!provider) return [];
  return getProviderSpecs(provider).filter((spec) => spec.kind !== "overview");
}
