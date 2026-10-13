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
    description: { ja: "長時間再生とノイズキャンセリングに対応。2台の機器を同時に接続でき、仕事や移動中も快適に音楽を楽しめます。", en: "Enjoy long battery life and noise cancellation. Connect two devices at once for music at work or on the move." },
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
    description: { ja: "イベントで頒布したアクリルスタンドの通販を開始しました。机に飾りやすいサイズで、台座付きも選べます。", en: "Our event acrylic stand is now available online. A compact size for your desk, with an optional display base." },
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
    title: { ja: "comebacktwitterembed", en: "comebacktwitterembed" },
    description: { ja: "Discordに共有したリンクを、画像や動画付きの投稿に展開するBot。YouTube、BOOTH、Steamなどに対応しています。", en: "A Discord bot that expands shared links into posts with images and videos. Supports YouTube, BOOTH, Steam, and more." },
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
    description: { ja: "雨上がりの街を歩いて見つけた風景。水たまりに映る夕空がきれいで、思わず足を止めました。お気に入りの4枚です。", en: "Scenes from a walk after the rain. The evening sky reflected in a puddle made me stop and take these four photos." },
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
    title: { ja: "【作業用BGM】夜の喫茶店", en: "[BGM] A Late-Night Café" },
    description: { ja: "静かな夜の喫茶店をイメージしたピアノ曲集です。勉強や読書のおともにどうぞ。気に入った曲をコメントで教えてください。", en: "A collection of piano pieces inspired by a quiet café at night. Enjoy while studying or reading, and tell us your favorite track." },
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
    description: { ja: "青い夜と小さな灯りをテーマに描きました。完成イラストと、線画から色を重ねるまでの制作過程をまとめています。", en: "An illustration about blue nights and small lights, with the finished artwork and progress from line art to final colors." },
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
    description: { ja: "夜のドライブに似合う、穏やかなシンセと軽やかなビート。Sample Artistの新作アルバムから先行公開した一曲です。", en: "Soft synths and a light beat for a night drive. An early release from Sample Artist's latest album." },
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
    description: { ja: "小さな島で出会った仲間たちと、失われた地図を探す冒険へ。探索とパズルを楽しみながら、島に隠された物語をたどります。", en: "Join new friends on a small island to find a lost map. Explore, solve puzzles, and uncover the island's hidden story." },
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
    description: { ja: "週末の朝ごはんを30秒で。焼きたてのパンとコーヒーで、ゆっくり一日を始めます。", en: "Weekend breakfast in 30 seconds. Freshly baked bread and coffee for a slow start to the day." },
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
    description: { ja: "今日の雑談配信から、思わず笑ってしまった場面を切り抜きました。遊びに来てくれたみなさん、ありがとう！", en: "A moment from today's stream that made us all laugh. Thanks to everyone who stopped by!" },
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
    description: { ja: "週末に海辺の街を散歩しました。夕方の光がきれいだったので、写真を2枚。駅前で見つけた小さな喫茶店のコーヒーもおいしくて、また訪れたくなる場所でした。次は朝の景色も撮ってみたいです。", en: "Spent the weekend walking through a seaside town. Two photos in the evening light, and a great coffee at a small café near the station. I'd love to return and photograph it in the morning." },
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
    title: { ja: "Discord Botの始め方", en: "Getting Started with a Discord Bot" },
    description: { ja: "Discord Botの導入から日々の運用までを紹介します。今回はサーバーへの追加、基本設定、通知の使い方を順番に試していきます。", en: "From adding a Discord bot to everyday use. This episode covers server setup, basic settings, and notifications step by step." },
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
  serviceName: "Sample",
  accentColor: "#5865f2",
  author: { ja: "サンプル投稿者", en: "Sample creator" },
  title: { ja: "週末の散歩", en: "A Weekend Walk" },
  description: { ja: "いつもの道を少し遠回りして、新しい景色を見つけました。お気に入りの一枚をお届けします。", en: "Took the long way home and found a new view. Here's my favorite photo from the walk." },
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

function visibleButtons(states: SettingState[], locale: DashboardLocale, providerId: string, gallery: boolean) {
  const t = createTranslator(locale);
  const buttonVisibility = (stateValue(states, "button_invisible") || {}) as Record<string, boolean>;
  if (buttonVisibility.all) return [];
  return Object.entries({
    translate: t("preview.button.translate"),
    delete: t("preview.button.delete"),
    showMediaAsAttachments: t("preview.button.attach"),
    showAttachmentsAsEmbedsImage: t("preview.button.embed"),
    savetweet: t("preview.button.save"),
    personal_save: locale === "ja" ? "あとで見る" : "Save for later",
    personal_remind: locale === "ja" ? "あとで通知" : "Remind me",
    ...(providerId === "booth" ? { personal_restock: locale === "ja" ? "再入荷を待つ" : "Watch restock" } : {}),
    ...(gallery ? { gallery: locale === "ja" ? "ギャラリー" : "Gallery" } : {}),
  })
    .filter(([key]) => !buttonVisibility[key] && !(key.startsWith("personal_") && buttonVisibility.personal)
      && (key !== "savetweet" || providerId === "twitter"))
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
  const gallery = ["pixiv", "instagram"].includes(providerId) && stateValue(states, "gallery_display_mode") === "gallery"
    && !showThumbnail && !showLinkOnly && Number(stateValue(states, providerId === "pixiv" ? "pixiv_images_per_step" : "instagram_media_limit")) !== 1
    && !((stateValue(states, "button_invisible") || {}) as Record<string, boolean>).all
    && !((stateValue(states, "button_invisible") || {}) as Record<string, boolean>).gallery;

  return {
    providerId,
    serviceName: fixture.serviceName,
    density,
    mediaMode,
    gallery,
    accentColor: fixture.accentColor,
    botName: createTranslator(locale)("preview.botName"),
    botBadge: createTranslator(locale)("preview.botBadge"),
    sourceButtonLabel: createTranslator(locale)("preview.sourceUrl"),
    timestamp: locale === "ja" ? "今日 12:34" : "Today at 12:34",
    replyContext: replyMode ? (locale === "ja" ? "元メッセージへの返信" : "Replying to source message") : null,
    messageContent: showLinkOnly ? fixture.sourceUrl : "",
    previousShareNotice: stateValue(states, "show_previous_shares") === false ? null : locale === "ja"
      ? "このチャンネルで以前にも共有されています · 前の投稿を見る（以前の共有がある場合）"
      : "Previously shared in this channel · View earlier post (when an earlier share exists)",
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
    image: showEmbedImage ? gallery ? (locale === "ja" ? "ギャラリーの1ページ目（表示例）" : "First gallery page (example)") : mediaLabel : null,
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
    buttons: visibleButtons(states, locale, providerId, gallery),
  };
}

export type ProviderPreview = ReturnType<typeof buildPreview>;
