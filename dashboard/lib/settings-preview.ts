import type { LocaleText, SettingState } from "@/lib/types";
import { createTranslator, localizedText, type DashboardLocale } from "@/lib/i18n";

type PreviewFieldFixture = {
  key?: string;
  name: LocaleText;
  value: LocaleText;
  inline?: boolean;
};

type PreviewFixture = {
  serviceName: string;
  accentColor: string;
  author: LocaleText;
  title: LocaleText;
  description: LocaleText;
  sourceUrl: string;
  mediaLabel: LocaleText;
  thumbnailLabel?: LocaleText;
  footer: LocaleText;
  fields: PreviewFieldFixture[];
};

const fixtures: Record<string, PreviewFixture> = {
  amazon: {
    serviceName: "Amazon",
    accentColor: "#ff9900",
    author: { ja: "Amazon.co.jp", en: "Amazon" },
    title: { ja: "ワイヤレスノイズキャンセリングヘッドホン", en: "Wireless noise-cancelling headphones" },
    description: { ja: "長時間再生、低遅延モード、マルチポイント接続に対応したサンプル商品です。", en: "A sample product with long battery life, low-latency mode, and multipoint pairing." },
    sourceUrl: "https://www.amazon.co.jp/dp/B0CBTE2026",
    mediaLabel: { ja: "商品画像", en: "Product image" },
    footer: { ja: "Amazon商品", en: "Amazon product" },
    fields: [
      { key: "price", name: { ja: "価格", en: "Price" }, value: { ja: "18,800円", en: "¥18,800" }, inline: true },
      { key: "rating", name: { ja: "評価", en: "Rating" }, value: { ja: "4.5 / 5", en: "4.5 / 5" }, inline: true },
      { key: "availability", name: { ja: "在庫", en: "Availability" }, value: { ja: "在庫あり", en: "In stock" }, inline: true },
    ],
  },
  booth: {
    serviceName: "Booth",
    accentColor: "#fc4d50",
    author: { ja: "サンプルショップ", en: "Sample Shop" },
    title: { ja: "アクリルスタンド comeback edition", en: "Acrylic stand comeback edition" },
    description: { ja: "イベント頒布後の通販サンプルです。画像、価格、販売状態の出方を確認できます。", en: "A sample listing showing image, price, and sale status presentation." },
    sourceUrl: "https://sample.booth.pm/items/1234567",
    mediaLabel: { ja: "商品画像4枚", en: "4 product images" },
    footer: { ja: "Booth商品", en: "Booth item" },
    fields: [
      { key: "price", name: { ja: "価格", en: "Price" }, value: { ja: "1,500円", en: "¥1,500" }, inline: true },
      { key: "status", name: { ja: "販売状態", en: "Sale status" }, value: { ja: "販売中", en: "On sale" }, inline: true },
      { key: "variations", name: { ja: "バリエーション", en: "Variations" }, value: { ja: "通常版 / 台座つき", en: "Standard / with base" }, inline: false },
    ],
  },
  github: {
    serviceName: "GitHub",
    accentColor: "#6e7681",
    author: { ja: "openai / codex", en: "openai / codex" },
    title: { ja: "Repository: comebacktwitterembed", en: "Repository: comebacktwitterembed" },
    description: { ja: "Providerカタログ駆動のDiscord BotとDashboardのサンプルリポジトリ表示です。", en: "A sample repository card for a catalog-driven Discord bot and dashboard." },
    sourceUrl: "https://github.com/example/comebacktwitterembed",
    mediaLabel: { ja: "リポジトリカード", en: "Repository card" },
    thumbnailLabel: { ja: "GitHubアイコン", en: "GitHub icon" },
    footer: { ja: "GitHub repository", en: "GitHub repository" },
    fields: [
      { key: "language", name: { ja: "主な言語", en: "Primary language" }, value: { ja: "JavaScript / TypeScript", en: "JavaScript / TypeScript" }, inline: true },
      { key: "repo_stats", name: { ja: "スター / フォーク", en: "Stars / forks" }, value: { ja: "1,248 / 86", en: "1,248 / 86" }, inline: true },
      { key: "topics", name: { ja: "Topics", en: "Topics" }, value: { ja: "discord, dashboard, embed", en: "discord, dashboard, embed" }, inline: false },
    ],
  },
  instagram: {
    serviceName: "Instagram",
    accentColor: "#e1306c",
    author: { ja: "@sample_creator", en: "@sample_creator" },
    title: { ja: "Instagram投稿", en: "Instagram post" },
    description: { ja: "カルーセル投稿のキャプション、いいね数、位置情報、メディア数の出方を確認できます。", en: "Preview caption, likes, location, and carousel media presentation." },
    sourceUrl: "https://www.instagram.com/p/CBTE2026/",
    mediaLabel: { ja: "カルーセル画像4枚", en: "4 carousel images" },
    footer: { ja: "Instagram", en: "Instagram" },
    fields: [
      { key: "likes", name: { ja: "いいね", en: "Likes" }, value: { ja: "8,240", en: "8,240" }, inline: true },
      { key: "comments", name: { ja: "コメント", en: "Comments" }, value: { ja: "128", en: "128" }, inline: true },
      { key: "hashtags", name: { ja: "ハッシュタグ", en: "Hashtags" }, value: { ja: "#dashboard #discord", en: "#dashboard #discord" }, inline: false },
    ],
  },
  niconico: {
    serviceName: "Niconico",
    accentColor: "#252525",
    author: { ja: "サンプル投稿者", en: "Sample uploader" },
    title: { ja: "【作業用BGM】Dashboard Preview", en: "[BGM] Dashboard Preview" },
    description: { ja: "説明文、再生数、コメント数、タグ、投稿者情報がどのように出るかを確認するサンプルです。", en: "A sample showing description, views, comments, tags, and uploader information." },
    sourceUrl: "https://www.nicovideo.jp/watch/sm12345678",
    mediaLabel: { ja: "動画サムネイル", en: "Video thumbnail" },
    footer: { ja: "Niconico動画", en: "Niconico video" },
    fields: [
      { key: "views", name: { ja: "再生", en: "Views" }, value: { ja: "124,000", en: "124,000" }, inline: true },
      { key: "comments", name: { ja: "コメント", en: "Comments" }, value: { ja: "3,210", en: "3,210" }, inline: true },
      { key: "tags", name: { ja: "タグ", en: "Tags" }, value: { ja: "音楽 / 作業用BGM / サンプル", en: "music / BGM / sample" }, inline: false },
    ],
  },
  pixiv: {
    serviceName: "Pixiv",
    accentColor: "#0096fa",
    author: { ja: "イラストレーター", en: "Illustrator" },
    title: { ja: "青い夜のキャラクターイラスト", en: "Blue night character illustration" },
    description: { ja: "タグ、年齢ラベル、ページ数、画像表示オプションを含むサンプル説明文です。", en: "A sample caption with tags, maturity labels, page count, and image display options." },
    sourceUrl: "https://www.pixiv.net/artworks/123456789",
    mediaLabel: { ja: "作品画像4ページ", en: "4 artwork pages" },
    footer: { ja: "Pixiv artwork", en: "Pixiv artwork" },
    fields: [
      { key: "pages", name: { ja: "ページ数", en: "Pages" }, value: { ja: "4", en: "4" }, inline: true },
      { key: "maturity", name: { ja: "年齢ラベル", en: "Maturity" }, value: { ja: "全年齢", en: "General" }, inline: true },
      { key: "tags", name: { ja: "タグ", en: "Tags" }, value: { ja: "オリジナル / 青 / 夜", en: "original / blue / night" }, inline: false },
    ],
  },
  spotify: {
    serviceName: "Spotify",
    accentColor: "#1db954",
    author: { ja: "Sample Artist", en: "Sample Artist" },
    title: { ja: "Night Drive - Sample Track", en: "Night Drive - Sample Track" },
    description: { ja: "トラック、アルバム、プレイリスト、アーティスト表示の説明文プレビューです。", en: "A description preview for track, album, playlist, and artist cards." },
    sourceUrl: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
    mediaLabel: { ja: "アルバムアート", en: "Album art" },
    footer: { ja: "Spotify track", en: "Spotify track" },
    fields: [
      { key: "album", name: { ja: "アルバム", en: "Album" }, value: { ja: "Dashboard Sessions", en: "Dashboard Sessions" }, inline: true },
      { key: "duration", name: { ja: "再生時間", en: "Duration" }, value: { ja: "3:42", en: "3:42" }, inline: true },
      { key: "date", name: { ja: "リリース", en: "Release" }, value: { ja: "2026", en: "2026" }, inline: true },
    ],
  },
  steam: {
    serviceName: "Steam",
    accentColor: "#66c0f4",
    author: { ja: "Steam Store", en: "Steam Store" },
    title: { ja: "Sample Adventure", en: "Sample Adventure" },
    description: { ja: "ストア説明文、価格、対応OS、レビュー概要、画像ソースの見え方を確認できます。", en: "Preview store description, price, platforms, review summary, and image source." },
    sourceUrl: "https://store.steampowered.com/app/123456/Sample_Adventure/",
    mediaLabel: { ja: "Steamヘッダー画像", en: "Steam header image" },
    footer: { ja: "Steam app", en: "Steam app" },
    fields: [
      { key: "price", name: { ja: "価格", en: "Price" }, value: { ja: "2,980円", en: "¥2,980" }, inline: true },
      { key: "platforms", name: { ja: "対応OS", en: "Platforms" }, value: { ja: "Windows / macOS", en: "Windows / macOS" }, inline: true },
      { key: "review_summary", name: { ja: "レビュー", en: "Reviews" }, value: { ja: "非常に好評", en: "Very Positive" }, inline: true },
    ],
  },
  tiktok: {
    serviceName: "TikTok",
    accentColor: "#25f4ee",
    author: { ja: "@sample_video", en: "@sample_video" },
    title: { ja: "TikTok動画", en: "TikTok video" },
    description: { ja: "動画キャプション、音源、統計、添付失敗時の代替表示を確認できます。", en: "Preview caption, music, stats, and video attachment fallback behavior." },
    sourceUrl: "https://www.tiktok.com/@sample/video/1234567890",
    mediaLabel: { ja: "縦動画プレビュー", en: "Vertical video preview" },
    footer: { ja: "TikTok", en: "TikTok" },
    fields: [
      { key: "stats", name: { ja: "再生 / いいね", en: "Views / likes" }, value: { ja: "42万 / 2.4万", en: "420K / 24K" }, inline: true },
      { key: "music", name: { ja: "楽曲", en: "Music" }, value: { ja: "Original sound", en: "Original sound" }, inline: true },
      { key: "tags", name: { ja: "ハッシュタグ", en: "Hashtags" }, value: { ja: "#discord #preview", en: "#discord #preview" }, inline: false },
    ],
  },
  twitch: {
    serviceName: "Twitch",
    accentColor: "#9146ff",
    author: { ja: "SampleStreamer", en: "SampleStreamer" },
    title: { ja: "今日のベストクリップ", en: "Best clip today" },
    description: { ja: "クリップ、配信中チャンネル、視聴者数、ゲーム名の出方を確認できます。", en: "Preview clip, live channel, viewer count, and game fields." },
    sourceUrl: "https://www.twitch.tv/sample/clip/CBTEPreview",
    mediaLabel: { ja: "クリップサムネイル", en: "Clip thumbnail" },
    footer: { ja: "Twitch clip", en: "Twitch clip" },
    fields: [
      { key: "game", name: { ja: "ゲーム", en: "Game" }, value: { ja: "Just Chatting", en: "Just Chatting" }, inline: true },
      { key: "views", name: { ja: "再生", en: "Views" }, value: { ja: "18,420", en: "18,420" }, inline: true },
      { key: "duration", name: { ja: "長さ", en: "Duration" }, value: { ja: "0:38", en: "0:38" }, inline: true },
    ],
  },
  twitter: {
    serviceName: "Twitter / X",
    accentColor: "#1d9bf0",
    author: { ja: "@comebacktwitterembed", en: "@comebacktwitterembed" },
    title: { ja: "Twitter / X 投稿", en: "Twitter / X post" },
    description: { ja: "Dashboardの設定変更により、出力密度、メディア表示、非表示項目がBot応答にどう反映されるかを確認できます。", en: "Dashboard-driven previews show how density, media mode, and hidden items change the bot response." },
    sourceUrl: "https://x.com/comebacktwitterembed/status/1234567890",
    mediaLabel: { ja: "画像2枚", en: "2 images" },
    footer: { ja: "Twitter / X", en: "Twitter / X" },
    fields: [
      { key: "stats", name: { ja: "反応", en: "Engagement" }, value: { ja: "返信12 / リポスト48 / いいね320", en: "12 replies / 48 reposts / 320 likes" }, inline: false },
      { key: "media_count", name: { ja: "メディア", en: "Media" }, value: { ja: "画像2枚", en: "2 images" }, inline: true },
      { key: "sensitive_media", name: { ja: "センシティブ", en: "Sensitive" }, value: { ja: "なし", en: "No" }, inline: true },
    ],
  },
  youtube: {
    serviceName: "YouTube",
    accentColor: "#ff0033",
    author: { ja: "Creator Channel", en: "Creator Channel" },
    title: { ja: "YouTube動画", en: "YouTube video" },
    description: { ja: "動画、プレイリスト、チャンネル向けのサンプル説明文です。動画リスト件数や統計の表示差分も確認できます。", en: "A sample description for videos, playlists, and channels, including list and stats differences." },
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    mediaLabel: { ja: "YouTubeサムネイル", en: "YouTube thumbnail" },
    footer: { ja: "YouTube video", en: "YouTube video" },
    fields: [
      { key: "duration", name: { ja: "再生時間", en: "Duration" }, value: { ja: "14:32", en: "14:32" }, inline: true },
      { key: "stats", name: { ja: "再生数", en: "Views" }, value: { ja: "12万回", en: "120K" }, inline: true },
      { key: "video_list", name: { ja: "関連リスト", en: "Video list" }, value: { ja: "1. 導入編\n2. 設定編\n3. 運用編", en: "1. Intro\n2. Settings\n3. Operations" }, inline: false },
    ],
  },
};

const fallbackFixture: PreviewFixture = {
  serviceName: "Provider",
  accentColor: "#5865f2",
  author: { ja: "Source service", en: "Source service" },
  title: { ja: "Providerプレビュー", en: "Provider preview" },
  description: { ja: "provider APIを呼ばずに、選択中の設定からfixtureプレビューを更新します。", en: "This fixture preview updates from the selected settings without calling the provider API." },
  sourceUrl: "https://example.com/source",
  mediaLabel: { ja: "メディアプレビュー", en: "Media preview" },
  footer: { ja: "comebacktwitterembed", en: "comebacktwitterembed" },
  fields: [{ key: "stats", name: { ja: "メタデータ", en: "Metadata" }, value: { ja: "サンプル項目", en: "Sample fields" }, inline: true }],
};

function text(value: LocaleText, locale: DashboardLocale) {
  return localizedText(value, locale);
}

function stateValue(states: SettingState[], key: string) {
  return states.find((state) => state.key === key)?.value;
}

function maxDescriptionLength(providerId: string, states: SettingState[]) {
  return Number(
    stateValue(states, `${providerId}_description_max_length`) ||
      stateValue(states, `${providerId}_caption_max_length`) ||
      stateValue(states, "youtube_description_max_length") ||
      700,
  );
}

function truncateDescription(value: string, maxLength: number, locale: DashboardLocale) {
  if (maxLength === 0) return "";
  const limit = Math.max(80, Math.min(maxLength, value.length));
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trim()}${locale === "ja" ? "…" : "..."}`;
}

function visibleButtons(states: SettingState[], locale: DashboardLocale) {
  const t = createTranslator(locale);
  const buttonVisibility = (stateValue(states, "button_invisible") || {}) as Record<string, boolean>;
  if (buttonVisibility.all) return [];
  return Object.entries({
    translate: t("preview.button.translate"),
    delete: t("preview.button.delete"),
    showMediaAsAttachments: t("preview.button.attach"),
    showAttachmentsAsEmbedsImage: t("preview.button.embed"),
    savetweet: t("preview.button.save"),
  })
    .filter(([key]) => !buttonVisibility[key])
    .map(([key, label]) => ({ key, label, danger: key === "delete" }));
}

export function buildPreview(providerId: string, states: SettingState[], locale: DashboardLocale = "ja") {
  const fixture = fixtures[providerId] || fallbackFixture;
  const density = String(stateValue(states, "display_density") || "standard");
  const mediaMode = String(stateValue(states, "media_display_mode") || "embed");
  const hidden = new Set((stateValue(states, "hidden_output_items") as string[]) || []);
  const replyMode = stateValue(states, "alwaysreplyifpostedtweetlink") === true;
  const anonymous = stateValue(states, "anonymous_expand") === true;
  const deleteSource = stateValue(states, "deletemessageifonlypostedtweetlink") === true;

  let title = text(fixture.title, locale);
  let description = truncateDescription(text(fixture.description, locale), maxDescriptionLength(providerId, states), locale);
  let fields = fixture.fields.filter((field) => !field.key || !hidden.has(field.key));

  if (providerId === "twitter") {
    const textMode = String(stateValue(states, "twitter_text_mode") || "normal");
    const statsLayout = String(stateValue(states, "twitter_stats_layout") || "description");
    if (textMode === "hidden") description = "";
    if (textMode === "link_only") description = fixture.sourceUrl;
    if (statsLayout === "hidden" || hidden.has("stats")) fields = fields.filter((field) => field.key !== "stats");
    if (hidden.has("article_title")) title = text({ ja: "Twitter / X", en: "Twitter / X" }, locale);
  }

  if (density === "compact") {
    fields = fields.filter((field) => field.inline).slice(0, 2);
    description = description.split("\n")[0].slice(0, 120);
  }

  const mediaLabel = text(fixture.mediaLabel, locale);
  const thumbnailLabel = text(fixture.thumbnailLabel || fixture.mediaLabel, locale);
  const showEmbedImage = mediaMode === "embed";
  const showThumbnail = mediaMode === "thumbnail_only";
  const showAttachment = mediaMode === "attachment";
  const showLinkOnly = mediaMode === "link_only";

  return {
    providerId,
    serviceName: fixture.serviceName,
    density,
    mediaMode,
    accentColor: fixture.accentColor,
    botName: createTranslator(locale)("preview.botName"),
    botBadge: createTranslator(locale)("preview.botBadge"),
    sourceButtonLabel: createTranslator(locale)("preview.sourceUrl"),
    timestamp: locale === "ja" ? "今日 12:34" : "Today at 12:34",
    replyContext: replyMode ? (locale === "ja" ? "元メッセージへの返信" : "Replying to source message") : null,
    messageContent: showLinkOnly ? fixture.sourceUrl : "",
    requester: anonymous ? (locale === "ja" ? "匿名のリクエスト" : "Anonymous request") : (locale === "ja" ? "Requested by yuyutti" : "Requested by yuyutti"),
    sourceDeletedNotice: deleteSource ? (locale === "ja" ? "元投稿は展開後に削除されます" : "Source message will be deleted after expansion") : null,
    author: text(fixture.author, locale),
    title,
    description,
    sourceUrl: fixture.sourceUrl,
    fields: fields.map((field) => ({
      key: field.key,
      name: text(field.name, locale),
      value: text(field.value, locale),
      inline: field.inline !== false,
    })),
    footer: `${text(fixture.footer, locale)} • comebacktwitterembed`,
    image: showEmbedImage ? mediaLabel : null,
    thumbnail: showThumbnail ? thumbnailLabel : null,
    attachments: showAttachment
      ? [
          {
            filename: `${providerId}-preview.jpg`,
            label: mediaLabel,
          },
        ]
      : [],
    linkOnlyMedia: showLinkOnly ? mediaLabel : null,
    buttons: visibleButtons(states, locale),
  };
}

export type ProviderPreview = ReturnType<typeof buildPreview>;
