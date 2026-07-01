import type { SettingState } from "@/lib/types";

type PreviewFixture = {
  title: string;
  author: string;
  text: string;
  mediaLabel: string;
  stats: string;
};

const fixtures: Record<string, PreviewFixture> = {
  twitter: {
    title: "Twitter / X post",
    author: "@comebacktwitterembed",
    text: "Dashboard-driven previews show how density, media mode, and hidden items change the bot response.",
    mediaLabel: "2 images",
    stats: "12 replies · 48 reposts · 320 likes",
  },
  pixiv: {
    title: "Pixiv artwork",
    author: "Illustrator",
    text: "A sample caption with tags, maturity labels, page count, and image display options.",
    mediaLabel: "4 pages",
    stats: "AI: no · R-18: no",
  },
  youtube: {
    title: "YouTube video",
    author: "Creator Channel",
    text: "A sample description for videos, playlists, and channels.",
    mediaLabel: "Thumbnail",
    stats: "120K views · 14:32",
  },
  default: {
    title: "Provider preview",
    author: "Source service",
    text: "This fixture preview updates from the selected settings without calling the provider API.",
    mediaLabel: "Media preview",
    stats: "Metadata fields",
  },
};

function stateValue(states: SettingState[], key: string) {
  return states.find((state) => state.key === key)?.value;
}

export function buildPreview(providerId: string, states: SettingState[]) {
  const fixture = fixtures[providerId] || fixtures.default;
  const density = String(stateValue(states, "display_density") || "standard");
  const mediaMode = String(stateValue(states, "media_display_mode") || "embed");
  const hidden = new Set((stateValue(states, "hidden_output_items") as string[]) || []);
  const buttonVisibility = (stateValue(states, "button_invisible") || {}) as Record<string, boolean>;

  const lines = [];
  if (density !== "compact") lines.push(fixture.author);
  if (!hidden.has("article_title")) lines.push(fixture.title);
  if (density !== "compact" && !hidden.has("stats")) lines.push(fixture.stats);
  if (!hidden.has("article_preview")) {
    const maxLength = Number(
      stateValue(states, `${providerId}_description_max_length`) ||
        stateValue(states, `${providerId}_caption_max_length`) ||
        240,
    );
    if (maxLength !== 0) lines.push(fixture.text.slice(0, Math.max(80, Math.min(maxLength, fixture.text.length))));
  }

  const media =
    mediaMode === "attachment"
      ? `Attachment: ${fixture.mediaLabel}`
      : mediaMode === "thumbnail_only"
        ? `Thumbnail: ${fixture.mediaLabel}`
        : mediaMode === "link_only"
          ? "Media URL only"
          : `Embed media: ${fixture.mediaLabel}`;

  const buttons = Object.entries({
    translate: "Translate",
    delete: "Delete",
    showMediaAsAttachments: "Attach",
    showAttachmentsAsEmbedsImage: "Embed",
    savetweet: "Save",
  })
    .filter(([key]) => !buttonVisibility[key])
    .map(([, label]) => label);

  return {
    providerId,
    density,
    mediaMode,
    title: fixture.title,
    lines,
    media,
    buttons,
  };
}
