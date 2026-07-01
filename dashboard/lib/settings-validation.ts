import "server-only";

import { z } from "zod";
import { editableSpecs, getProvider, getProviderSettingColumns } from "@/lib/settings-catalog";
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

function parseScalarChoice(spec: SettingSpec, value: unknown) {
  const choices = spec.choices?.map((choice) => String(choice.value)) || [];
  const textValue = String(value);
  if (!choices.includes(textValue)) {
    throw new Error(`Invalid value for ${spec.key}. Allowed values: ${choices.join(", ")}`);
  }

  const columnType = getProviderSettingColumns()[spec.key]?.type;
  if (columnType === "int") return Number(textValue);
  return textValue;
}

function validateOutputItems(spec: SettingSpec, value: unknown) {
  const values = hiddenOutputItemsSchema.parse(Array.isArray(value) ? value : []);
  const allowed = new Set((spec.outputItems || []).map((item) => item.value));
  const invalid = values.filter((item) => !allowed.has(item));
  if (invalid.length > 0) {
    throw new Error(`Invalid hidden output item for ${spec.key}: ${invalid.join(", ")}`);
  }
  return uniqueStrings(values);
}

function validateSpecValue(providerId: string, spec: SettingSpec, value: unknown): SettingValue {
  if (value === null) {
    if (spec.kind === "targets") return { user: [], channel: [], role: [] };
    if (spec.kind === "bannedWords" || spec.kind === "outputVisibility") return [];
    if (spec.kind === "buttonVisibility") return {};
    return null;
  }

  if (spec.kind === "providerEnabled" || spec.kind === "bool") return z.boolean().parse(value);
  if (spec.kind === "choice") return parseScalarChoice(spec, value);
  if (spec.kind === "targets") return normalizeTargets(value);
  if (spec.kind === "buttonVisibility") return normalizeButtonVisibility(providerId, value);
  if (spec.kind === "bannedWords") return uniqueStrings(z.array(z.string().min(1).max(255)).parse(value || []));
  if (spec.kind === "outputVisibility") return validateOutputItems(spec, value);

  throw new Error(`Setting ${spec.key} cannot be edited`);
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

export function validateProviderChanges(providerId: string, input: unknown): ValidatedChanges {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  const body = z.object({ changes: z.record(z.unknown()).default({}) }).parse(input || {});
  const specs = new Map(editableSpecs(providerId).map((spec) => [spec.key, spec]));
  const changes: Record<string, SettingValue> = {};
  const warnings: string[] = [];
  let dangerous = false;

  for (const [key, rawValue] of Object.entries(body.changes)) {
    const spec = specs.get(key);
    if (!spec) throw new Error(`Provider ${providerId} does not support setting ${key}`);
    const value = validateSpecValue(providerId, spec, rawValue);
    changes[key] = value;
    if (isDangerousSetting(key, value)) dangerous = true;
  }

  if (changes.legacy_mode === true && changes.secondary_extract_mode !== false) {
    changes.secondary_extract_mode = false;
    warnings.push("legacy_mode=true requires secondary_extract_mode=false. The dashboard applied that compatibility rule.");
  }

  if (changes.secondary_extract_mode === true && changes.legacy_mode !== false) {
    changes.legacy_mode = false;
    warnings.push("secondary_extract_mode=true requires legacy_mode=false. The dashboard applied that compatibility rule.");
  }

  return { changes, warnings, dangerous };
}

export function settingWarnings(key: string, value: SettingValue, currentValues: Record<string, SettingValue | undefined>) {
  const warnings: string[] = [];
  if (key === "secondary_extract_mode_multiple_images" && currentValues.secondary_extract_mode !== true) {
    warnings.push("secondary_extract_mode is off, so this image condition has no effect.");
  }
  if (key === "secondary_extract_mode_video" && currentValues.secondary_extract_mode !== true) {
    warnings.push("secondary_extract_mode is off, so this video condition has no effect.");
  }
  if (key === "quote_repost_max_depth" && currentValues.twitter_quote_mode === "hidden") {
    warnings.push("twitter_quote_mode=hidden makes quote depth mostly irrelevant.");
  }
  if (key === "quote_repost_max_depth" && Number(value) === 0) {
    warnings.push("Unlimited quote depth can produce noisy output.");
  }
  if (key === "media_display_mode" && value === "attachment") {
    warnings.push("Attachment media mode can make busy media channels heavier.");
  }
  if (key === "failure_display_policy" && value === "error_summary") {
    warnings.push("error_summary can add noise in normal channels.");
  }
  if (key === "booth_adult_display_mode" && value === "normal") {
    warnings.push("Adult Booth media will be displayed normally. Confirm this matches server rules.");
  }
  return warnings;
}
