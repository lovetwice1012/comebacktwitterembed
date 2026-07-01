import "server-only";

import { z } from "zod";
import { editableSpecs, getProvider, getProviderSettingColumns } from "@/lib/settings-catalog";
import { createTranslator, type DashboardLocale } from "@/lib/i18n";
import type { ButtonVisibility, SettingSpec, SettingValue, TargetSetting } from "@/lib/types";

const snowflakeSchema = z.string().regex(/^\d{5,32}$/);

const targetsSchema = z.object({
  user: z.array(snowflakeSchema).default([]),
  channel: z.array(snowflakeSchema).default([]),
  role: z.array(snowflakeSchema).default([]),
});

const hiddenOutputItemsSchema = z.array(z.string().min(1).max(64)).default([]);

const buttonVisibilityKeys = [
  "showMediaAsAttachments",
  "showAttachmentsAsEmbedsImage",
  "translate",
  "delete",
  "all",
  "savetweet",
] as const;

const buttonVisibilitySchema = z.record(z.enum(buttonVisibilityKeys), z.boolean()).default({});

export type ValidatedChanges = {
  changes: Record<string, SettingValue>;
  warnings: string[];
  dangerous: boolean;
};

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => String(value || "").normalize("NFC").trim()).filter(Boolean))];
}

function normalizeTargets(value: unknown): TargetSetting {
  const parsed = targetsSchema.parse(value || {});
  return {
    user: [...new Set(parsed.user)],
    channel: [...new Set(parsed.channel)],
    role: [...new Set(parsed.role)],
  };
}

function normalizeButtonVisibility(providerId: string, value: unknown): ButtonVisibility {
  const parsed = buttonVisibilitySchema.parse(value || {});
  if (providerId !== "twitter") delete parsed.savetweet;
  return parsed;
}

function parseScalarChoice(spec: SettingSpec, value: unknown, locale: DashboardLocale) {
  const t = createTranslator(locale);
  const choices = spec.choices?.map((choice) => String(choice.value)) || [];
  const textValue = String(value);
  if (!choices.includes(textValue)) {
    throw new Error(t("validation.invalidChoice", { key: spec.key, values: choices.join(", ") }));
  }

  const columnType = getProviderSettingColumns()[spec.key]?.type;
  if (columnType === "int") return Number(textValue);
  return textValue;
}

function parseMultiChoice(spec: SettingSpec, value: unknown, locale: DashboardLocale) {
  const t = createTranslator(locale);
  const values = z.array(z.string().min(1).max(64)).parse(Array.isArray(value) ? value : []);
  const allowed = new Set(spec.choices?.map((choice) => String(choice.value)) || []);
  const invalid = values.filter((item) => !allowed.has(item));
  if (invalid.length > 0) {
    throw new Error(t("validation.invalidChoice", { key: spec.key, values: [...allowed].join(", ") }));
  }
  return uniqueStrings(values);
}

function validateOutputItems(spec: SettingSpec, value: unknown, locale: DashboardLocale) {
  const t = createTranslator(locale);
  const values = hiddenOutputItemsSchema.parse(Array.isArray(value) ? value : []);
  const allowed = new Set((spec.outputItems || []).map((item) => item.value));
  const invalid = values.filter((item) => !allowed.has(item));
  if (invalid.length > 0) {
    throw new Error(t("validation.invalidOutputItem", { key: spec.key, values: invalid.join(", ") }));
  }
  return uniqueStrings(values);
}

function validateSpecValue(providerId: string, spec: SettingSpec, value: unknown, locale: DashboardLocale): SettingValue {
  const t = createTranslator(locale);
  if (value === null) {
    if (spec.kind === "targets") return { user: [], channel: [], role: [] };
    if (spec.kind === "bannedWords" || spec.kind === "outputVisibility" || spec.kind === "multiChoice") return [];
    if (spec.kind === "buttonVisibility") return {};
    return null;
  }

  if (spec.kind === "providerEnabled" || spec.kind === "bool") return z.boolean().parse(value);
  if (spec.kind === "choice") return parseScalarChoice(spec, value, locale);
  if (spec.kind === "multiChoice") return parseMultiChoice(spec, value, locale);
  if (spec.kind === "targets") return normalizeTargets(value);
  if (spec.kind === "buttonVisibility") return normalizeButtonVisibility(providerId, value);
  if (spec.kind === "bannedWords") return uniqueStrings(z.array(z.string().min(1).max(255)).parse(value || []));
  if (spec.kind === "outputVisibility") return validateOutputItems(spec, value, locale);

  throw new Error(t("validation.readOnlySetting", { key: spec.key }));
}

function isDangerousSetting(key: string, value: SettingValue) {
  if (key === "quote_repost_max_depth" && Number(value) === 0) return true;
  if (key === "media_display_mode" && value === "attachment") return true;
  if (key === "failure_display_policy" && value === "error_summary") return true;
  if (key === "booth_adult_display_mode" && value === "normal") return true;
  if (key === "extract_bot_message" && value === true) return true;
  if (key.includes("deletemessage") && value === true) return true;
  return false;
}

export function validateProviderChanges(providerId: string, input: unknown, locale: DashboardLocale = "ja"): ValidatedChanges {
  const t = createTranslator(locale);
  const provider = getProvider(providerId);
  if (!provider) throw new Error(t("validation.unknownProvider", { providerId }));

  const body = z.object({ changes: z.record(z.unknown()).default({}) }).parse(input || {});
  const specs = new Map(editableSpecs(providerId).map((spec) => [spec.key, spec]));
  const changes: Record<string, SettingValue> = {};
  const warnings: string[] = [];
  let dangerous = false;

  for (const [key, rawValue] of Object.entries(body.changes)) {
    const spec = specs.get(key);
    if (!spec) throw new Error(t("validation.unsupportedSetting", { providerId, key }));
    const value = validateSpecValue(providerId, spec, rawValue, locale);
    changes[key] = value;
    if (isDangerousSetting(key, value)) dangerous = true;
  }

  if (changes.legacy_mode === true && changes.secondary_extract_mode !== false) {
    changes.secondary_extract_mode = false;
    warnings.push(t("validation.legacyConflict"));
  }

  if (changes.secondary_extract_mode === true && changes.legacy_mode !== false) {
    changes.legacy_mode = false;
    warnings.push(t("validation.secondaryConflict"));
  }

  return { changes, warnings, dangerous };
}

export function settingWarnings(key: string, value: SettingValue, currentValues: Record<string, SettingValue | undefined>, locale: DashboardLocale = "ja") {
  const t = createTranslator(locale);
  const warnings: string[] = [];
  if (key === "secondary_extract_mode_multiple_images" && currentValues.secondary_extract_mode !== true) {
    warnings.push(t("warning.secondaryImagesNoEffect"));
  }
  if (key === "secondary_extract_mode_video" && currentValues.secondary_extract_mode !== true) {
    warnings.push(t("warning.secondaryVideoNoEffect"));
  }
  if (key === "quote_repost_max_depth" && currentValues.twitter_quote_mode === "hidden") {
    warnings.push(t("warning.quoteDepthIrrelevant"));
  }
  if (key === "quote_repost_max_depth" && Number(value) === 0) {
    warnings.push(t("warning.unlimitedQuoteDepth"));
  }
  if (key === "media_display_mode" && value === "attachment") {
    warnings.push(t("warning.attachmentHeavy"));
  }
  if (key === "failure_display_policy" && value === "error_summary") {
    warnings.push(t("warning.errorSummaryNoisy"));
  }
  if (key === "booth_adult_display_mode" && value === "normal") {
    warnings.push(t("warning.boothAdultNormal"));
  }
  return warnings;
}
