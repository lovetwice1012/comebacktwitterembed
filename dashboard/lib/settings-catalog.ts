import "server-only";

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
  PROVIDER_SETTING_COLUMNS: Record<string, { column: string; type: "bool" | "int" | "string" | "jsonArray" }>;
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

function textValue(value: LocaleText | undefined, fallback: string): LocaleText {
  if (!value) return { en: fallback, ja: fallback };
  if (typeof value === "string") return value;
  return {
    ...value,
    en: value.en || value.ja || fallback,
    ja: value.ja || value.en || fallback,
  };
}

function categoryFor(spec: BotSettingSpec) {
  const key = spec.key || spec.settingKey || "";
  if (spec.kind === "providerEnabled") return "基本";
  if (spec.kind === "targets") return "対象制御";
  if (spec.kind === "buttonVisibility") return "ボタン";
  if (spec.kind === "bannedWords") return "削除・抑制";
  if (spec.kind === "outputVisibility") return "高度な設定";
  if (key.includes("language") || key.includes("translate")) return "翻訳";
  if (key.includes("media") || key.includes("image") || key.includes("attachment") || key.includes("download")) return "メディア";
  if (key.includes("delete") || key.includes("legacy") || key.includes("passive") || key.includes("banned")) return "削除・抑制";
  if (key.includes("failure") || key.includes("fallback")) return "失敗時動作";
  if (key.includes("density") || key.includes("description") || key.includes("caption") || key.includes("text") || key.includes("layout") || key.includes("stats")) return "出力表示";
  return "provider専用";
}

function impactFor(spec: BotSettingSpec) {
  const key = spec.key || spec.settingKey || "";
  if (
    key.includes("adult_display_mode") ||
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
  if (spec.kind === "targets" || spec.kind === "buttonVisibility" || spec.kind === "outputVisibility") return "medium" as const;
  return "low" as const;
}

function dependenciesFor(spec: BotSettingSpec) {
  const key = spec.key || spec.settingKey || "";
  if (key === "secondary_extract_mode_multiple_images" || key === "secondary_extract_mode_video" || key === "deletemessageifonlypostedtweetlink_secoundaryextractmode") {
    return ["secondary_extract_mode"];
  }
  if (key === "quote_repost_max_depth") return ["twitter_quote_mode", "quote_repost_do_not_extract"];
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
    key.includes("legacy") ||
    key.includes("secondary") ||
    key.includes("fallback") ||
    key.includes("quote_repost") ||
    key.includes("adult_display_mode")
  );
}

function serializeSpec(spec: BotSettingSpec): SettingSpec | null {
  const key = spec.key || spec.settingKey;
  if (!key || !spec.kind) return null;
  const columns = getProviderSettingColumns();
  return {
    key,
    settingKey: spec.settingKey || key,
    label: textValue(spec.label, key),
    description: textValue(spec.description, key),
    kind: spec.kind,
    choices: spec.choices?.map((choice) => ({
      label: textValue(choice.label, String(choice.value)),
      value: String(choice.value),
    })),
    outputItems: spec.outputItems?.map((item) => ({
      value: item.value,
      label: textValue(item.label, item.value),
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
  return specsModule
    .getProviderSettingSpecs(provider, options)
    .map(serializeSpec)
    .filter((spec): spec is SettingSpec => Boolean(spec));
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
