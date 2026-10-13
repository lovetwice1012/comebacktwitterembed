import { createTranslator, labelText, valueLabel, type DashboardLocale, type TranslationKey } from "@/lib/i18n";
import type { SettingState, SettingValue } from "@/lib/types";

const titles: Record<string, [string, string]> = {
  enabled: ["リンクを展開", "Expand links"],
  disable: ["展開しないユーザー・チャンネル・ロール", "Exclude users, channels and roles"],
  display_density: ["表示する情報量", "Amount of detail"],
  media_display_mode: ["画像・動画の表示方法", "Image and video display"],
  defaultLanguage: ["表示・翻訳の言語", "Display and translation language"],
  button_invisible: ["非表示にするボタン", "Hide selected buttons"],
  button_disabled: ["ボタンを使えないユーザー・チャンネル・ロール", "Restrict button access"],
  failure_display_policy: ["リンクを取得できないとき", "When a link cannot be fetched"],
  bannedWords: ["指定した語を含む投稿を除外", "Exclude posts containing these words"],
  editOriginalIfTranslate: ["翻訳で元のBot応答を置き換える", "Replace the bot response with its translation"],
  hidden_output_items: ["非表示にする情報", "Hide selected information"],
  deletemessageifonlypostedtweetlink_secoundaryextractmode: ["条件で絞った展開でも元投稿を削除", "Delete source messages for filtered expansions"],
  suppress_source_embeds_if_only_posted_tweet_link_secondary_extract_mode: ["条件で絞った展開でも元リンクのプレビューを隠す", "Hide source previews for filtered expansions"],
  secondary_extract_mode: ["動画・複数画像の投稿に絞る", "Expand only selected media posts"],
  quote_repost_depth_by_account: ["アカウント別の引用展開数", "Quote depth by account"],
};

const choices: Record<string, Record<string, [string, string]>> = {
  media_display_mode: {
    embed: ["本文と一緒に表示", "Show with the message"],
    attachment: ["ファイルで送信", "Send as files"],
    thumbnail_only: ["小さな画像だけ表示", "Show a small image"],
    link_only: ["リンクだけ表示", "Show links only"],
  },
  display_density: {
    compact: ["少なめ", "Less detail"],
    standard: ["標準", "Standard"],
    detail: ["詳しく", "More detail"],
  },
};

const buttonTitles: Record<string, TranslationKey> = {
  showMediaAsAttachments: "form.button.showMediaAsAttachments", showAttachmentsAsEmbedsImage: "form.button.showAttachmentsAsEmbedsImage",
  translate: "form.button.translate", delete: "form.button.delete", savetweet: "form.button.savetweet", personal: "form.button.personal",
  personal_save: "form.button.personal_save", personal_remind: "form.button.personal_remind", personal_restock: "form.button.personal_restock",
  gallery: "form.button.gallery", all: "form.button.all",
};

export function settingTitle(setting: SettingState, locale: DashboardLocale) {
  const title = titles[setting.key];
  return title ? title[locale === "ja" ? 0 : 1] : labelText(setting.spec.label, locale);
}

export function settingChoiceTitle(setting: SettingState, value: string, locale: DashboardLocale) {
  const title = choices[setting.key]?.[value];
  const choice = setting.spec.choices?.find(item => String(item.value) === value);
  return title ? title[locale === "ja" ? 0 : 1] : choice ? labelText(choice.label, locale) : value;
}

export function settingDisplayValue(setting: SettingState | undefined, value: SettingValue | undefined, locale: DashboardLocale) {
  if (setting?.spec.kind === "choice") return settingChoiceTitle(setting, String(value), locale);
  if (Array.isArray(value)) {
    return value.length ? value.map(item => {
      const option = setting?.spec.choices?.find(choice => choice.value === item) || setting?.spec.outputItems?.find(choice => choice.value === item);
      return option ? labelText(option.label, locale) : item;
    }).join("\n") : locale === "ja" ? "指定なし" : "None selected";
  }
  if (value && typeof value === "object") {
    if (setting?.spec.kind === "targets") {
      const labels = locale === "ja" ? { user: "ユーザー", channel: "チャンネル", role: "ロール" } : { user: "Users", channel: "Channels", role: "Roles" };
      const lines = Object.entries(value).filter(([, ids]) => Array.isArray(ids) && ids.length).map(([key, ids]) => `${labels[key as keyof typeof labels] || key}  ${(ids as string[]).join(", ")}`);
      return lines.length ? lines.join("\n") : locale === "ja" ? "指定なし" : "None selected";
    }
    if (setting?.spec.kind === "buttonVisibility") {
      const t = createTranslator(locale);
      const hidden = Object.entries(value).filter(([, item]) => item === true).map(([key]) => buttonTitles[key] ? t(buttonTitles[key]) : key);
      return hidden.length ? hidden.join("\n") : locale === "ja" ? "すべて表示" : "All visible";
    }
    const lines = Object.entries(value).map(([key, item]) => `${key}  ${item}`);
    return lines.length ? lines.join("\n") : locale === "ja" ? "指定なし" : "None selected";
  }
  return valueLabel(value, locale);
}

export function isCommonSetting(setting: SettingState, settings: SettingState[]) {
  return settings.length <= 6 || setting.spec.recommended || setting.spec.category === "basic" || setting.key === "silent_expansion" || setting.key === "show_previous_shares";
}
