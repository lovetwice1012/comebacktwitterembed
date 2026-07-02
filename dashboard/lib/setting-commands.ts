import type { ButtonVisibility, SettingState, SettingValue, TargetSetting } from "@/lib/types";

export type SettingCommand = {
  command: string;
};

const providerOptionSettings = new Map<string, string>([
  ["editOriginalIfTranslate", "editoriginaliftranslate"],
  ["extract_bot_message", "extractbotmessage"],
  ["sendMediaAsAttachmentsAsDefault", "setdefaultmediaasattachments"],
  ["deletemessageifonlypostedtweetlink", "deleteifonlypostedtweetlink"],
  ["alwaysreplyifpostedtweetlink", "alwaysreplyifpostedtweetlink"],
  ["anonymous_expand", "anonymousexpand"],
  ["legacy_mode", "legacymode"],
]);

const buttonVisibilityOptions: Array<[keyof ButtonVisibility, string]> = [
  ["showMediaAsAttachments", "showmediaasattachments"],
  ["showAttachmentsAsEmbedsImage", "showattachmentsasembedsimage"],
  ["translate", "translate"],
  ["delete", "delete"],
  ["savetweet", "savetweet"],
];

function boolOption(value: SettingValue | undefined) {
  return value === true ? "true" : "false";
}

function optionValue(value: unknown) {
  const text = String(value ?? "");
  return /[\s"\\]/.test(text) ? JSON.stringify(text) : text;
}

function settingsCommand(subcommand: string, providerId: string, options: string[]) {
  return `/settings ${subcommand} ${[...options, `provider:${providerId}`].join(" ")}`;
}

function targetCommands(subcommand: string, providerId: string, value: SettingValue) {
  const targets = value as TargetSetting | null | undefined;
  const commands: SettingCommand[] = [];
  for (const targetType of ["user", "channel", "role"] as const) {
    for (const targetId of targets?.[targetType] || []) {
      commands.push({ command: settingsCommand(subcommand, providerId, [`${targetType}:${optionValue(targetId)}`]) });
    }
  }
  return commands;
}

function bannedWordCommands(providerId: string, value: SettingValue) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((word): word is string => typeof word === "string" && word.trim().length > 0)
    .map((word) => ({ command: settingsCommand("bannedwords", providerId, [`word:${optionValue(word)}`]) }));
}

function buttonVisibilityCommand(providerId: string, value: SettingValue) {
  const visibility = (value || {}) as ButtonVisibility;
  const options = buttonVisibilityOptions
    .filter(([key]) => providerId === "twitter" || key !== "savetweet")
    .map(([key, optionName]) => `${optionName}:${visibility[key] === true ? "true" : "false"}`);
  return options.length ? [{ command: settingsCommand("button_invisible", providerId, options) }] : [];
}

function providerOptionBoolCommand(providerId: string, subcommand: string, value: SettingValue) {
  return [{ command: settingsCommand(subcommand, providerId, [`boolean:${boolOption(value)}`]) }];
}

function secondaryDeleteCommand(providerId: string, value: SettingValue, values: Record<string, SettingValue | undefined>) {
  return [{
    command: settingsCommand("deleteifonlypostedtweetlink", providerId, [
      `boolean:${boolOption(values.deletemessageifonlypostedtweetlink)}`,
      `secoundaryextractmode:${boolOption(value)}`,
    ]),
  }];
}

function twitterCommand(setting: SettingState, value: SettingValue, values: Record<string, SettingValue | undefined>) {
  if (setting.key === "passive_mode") {
    return [{ command: `/settings twitter passivemode boolean:${boolOption(value)}` }];
  }
  if (setting.key === "quote_repost_do_not_extract") {
    return [{ command: `/settings twitter quoterepostdonotextract boolean:${boolOption(value)}` }];
  }
  if (setting.key === "quote_repost_max_depth") {
    return [{ command: `/settings twitter quoterepostmaxdepth depth:${optionValue(value)}` }];
  }
  if (setting.key === "secondary_extract_mode") {
    return [{ command: `/settings twitter secondaryextractmode boolean:${boolOption(value)}` }];
  }
  if (setting.key === "secondary_extract_mode_multiple_images" || setting.key === "secondary_extract_mode_video") {
    const multipleImages = values.secondary_extract_mode_multiple_images ?? (setting.key === "secondary_extract_mode_multiple_images" ? value : undefined);
    const video = values.secondary_extract_mode_video ?? (setting.key === "secondary_extract_mode_video" ? value : undefined);
    const options = [
      multipleImages === undefined ? null : `multipleimages:${boolOption(multipleImages)}`,
      video === undefined ? null : `video:${boolOption(video)}`,
    ].filter((option): option is string => Boolean(option));
    return options.length ? [{ command: `/settings twitter secondaryextracttarget ${options.join(" ")}` }] : [];
  }
  return [];
}

function pixivCommand(setting: SettingState, value: SettingValue) {
  if (setting.key !== "pixiv_images_per_step" || value === null || value === undefined) return [];
  return [{ command: `/settings pixiv images_per_step value:${optionValue(value)}` }];
}

export function settingCommandsForValue(
  providerId: string,
  setting: SettingState,
  value: SettingValue,
  values: Record<string, SettingValue | undefined>,
): SettingCommand[] {
  if (setting.key === "enabled") {
    return [{ command: `/provider ${value === true ? "enable" : "disable"} id:${providerId}` }];
  }
  if (setting.key === "defaultLanguage" && value !== null && value !== undefined) {
    return [{ command: settingsCommand("defaultlanguage", providerId, [`language:${optionValue(value)}`]) }];
  }
  if (setting.key === "disable") return targetCommands("disable", providerId, value);
  if (setting.key === "button_disabled") return targetCommands("button_disabled", providerId, value);
  if (setting.key === "button_invisible") return buttonVisibilityCommand(providerId, value);
  if (setting.key === "bannedWords") return bannedWordCommands(providerId, value);
  if (setting.key === "deletemessageifonlypostedtweetlink_secoundaryextractmode") {
    return secondaryDeleteCommand(providerId, value, values);
  }

  const providerSubcommand = providerOptionSettings.get(setting.key);
  if (providerSubcommand) return providerOptionBoolCommand(providerId, providerSubcommand, value);

  if (providerId === "twitter") return twitterCommand(setting, value, values);
  if (providerId === "pixiv") return pixivCommand(setting, value);
  return [];
}
