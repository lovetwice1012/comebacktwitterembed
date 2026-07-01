import type { SettingState } from "@/lib/types";
import { createTranslator, type DashboardLocale, type TranslationKey } from "@/lib/i18n";

type PreviewFixture = {
  titleKey: TranslationKey;
  authorKey: TranslationKey;
  textKey: TranslationKey;
  mediaKey: TranslationKey;
  statsKey: TranslationKey;
};

const fixtures: Record<string, PreviewFixture> = {
  twitter: {
    titleKey: "preview.fixture.twitter.title",
    authorKey: "preview.fixture.twitter.author",
    textKey: "preview.fixture.twitter.text",
    mediaKey: "preview.fixture.twitter.media",
    statsKey: "preview.fixture.twitter.stats",
  },
  pixiv: {
    titleKey: "preview.fixture.pixiv.title",
    authorKey: "preview.fixture.pixiv.author",
    textKey: "preview.fixture.pixiv.text",
    mediaKey: "preview.fixture.pixiv.media",
    statsKey: "preview.fixture.pixiv.stats",
  },
  youtube: {
    titleKey: "preview.fixture.youtube.title",
    authorKey: "preview.fixture.youtube.author",
    textKey: "preview.fixture.youtube.text",
    mediaKey: "preview.fixture.youtube.media",
    statsKey: "preview.fixture.youtube.stats",
  },
  default: {
    titleKey: "preview.fixture.default.title",
    authorKey: "preview.fixture.default.author",
    textKey: "preview.fixture.default.text",
    mediaKey: "preview.fixture.default.media",
    statsKey: "preview.fixture.default.stats",
  },
};

function stateValue(states: SettingState[], key: string) {
  return states.find((state) => state.key === key)?.value;
}

export function buildPreview(providerId: string, states: SettingState[], locale: DashboardLocale = "ja") {
  const fixture = fixtures[providerId] || fixtures.default;
  const t = createTranslator(locale);
  const title = t(fixture.titleKey);
  const author = t(fixture.authorKey);
  const text = t(fixture.textKey);
  const mediaLabel = t(fixture.mediaKey);
  const stats = t(fixture.statsKey);
  const density = String(stateValue(states, "display_density") || "standard");
  const mediaMode = String(stateValue(states, "media_display_mode") || "embed");
  const hidden = new Set((stateValue(states, "hidden_output_items") as string[]) || []);
  const buttonVisibility = (stateValue(states, "button_invisible") || {}) as Record<string, boolean>;

  const lines = [];
  if (density !== "compact") lines.push(author);
  if (!hidden.has("article_title")) lines.push(title);
  if (density !== "compact" && !hidden.has("stats")) lines.push(stats);
  if (!hidden.has("article_preview")) {
    const maxLength = Number(
      stateValue(states, `${providerId}_description_max_length`) ||
        stateValue(states, `${providerId}_caption_max_length`) ||
        240,
    );
    if (maxLength !== 0) lines.push(text.slice(0, Math.max(80, Math.min(maxLength, text.length))));
  }

  const media =
    mediaMode === "attachment"
      ? t("preview.media.attachment", { label: mediaLabel })
      : mediaMode === "thumbnail_only"
        ? t("preview.media.thumbnail", { label: mediaLabel })
        : mediaMode === "link_only"
          ? t("preview.media.linkOnly")
          : t("preview.media.embed", { label: mediaLabel });

  const buttons = Object.entries({
    translate: t("preview.button.translate"),
    delete: t("preview.button.delete"),
    showMediaAsAttachments: t("preview.button.attach"),
    showAttachmentsAsEmbedsImage: t("preview.button.embed"),
    savetweet: t("preview.button.save"),
  })
    .filter(([key]) => !buttonVisibility[key])
    .map(([, label]) => label);

  return {
    providerId,
    density,
    mediaMode,
    title,
    lines,
    media,
    buttons,
  };
}
