import type { SettingState } from "@/lib/types";
import { createTranslator, type DashboardLocale } from "@/lib/i18n";

export type DiagnosticIssue = {
  level: "info" | "notice" | "warning" | "danger";
  title: string;
  detail: string;
  settingKey?: string;
  quickFix?: Record<string, unknown>;
};

function value(states: SettingState[], key: string) {
  return states.find((state) => state.key === key)?.value;
}

export function diagnoseProvider(providerId: string, states: SettingState[], locale: DashboardLocale = "ja"): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const t = createTranslator(locale);

  if (value(states, "enabled") !== true) {
    issues.push({
      level: "info",
      title: t("diagnostics.providerDisabled.title"),
      detail: t("diagnostics.providerDisabled.detail"),
      settingKey: "enabled",
      quickFix: { enabled: true },
    });
  }

  if (value(states, "media_display_mode") === "attachment") {
    issues.push({
      level: ["instagram", "pixiv", "tiktok", "booth"].includes(providerId) ? "warning" : "notice",
      title: t("diagnostics.attachmentMode.title"),
      detail: t("diagnostics.attachmentMode.detail"),
      settingKey: "media_display_mode",
      quickFix: { media_display_mode: "embed" },
    });
  }

  if (value(states, "failure_display_policy") === "error_summary") {
    issues.push({
      level: "notice",
      title: t("diagnostics.errorSummary.title"),
      detail: t("diagnostics.errorSummary.detail"),
      settingKey: "failure_display_policy",
      quickFix: { failure_display_policy: "source_link" },
    });
  }

  if (providerId === "twitter" && value(states, "quote_repost_max_depth") === 0) {
    issues.push({
      level: "danger",
      title: t("diagnostics.unlimitedQuoteDepth.title"),
      detail: t("diagnostics.unlimitedQuoteDepth.detail"),
      settingKey: "quote_repost_max_depth",
      quickFix: { quote_repost_max_depth: "2" },
    });
  }

  if (value(states, "legacy_mode") === true && value(states, "secondary_extract_mode") === true) {
    issues.push({
      level: "danger",
      title: t("diagnostics.conflictingTwitterModes.title"),
      detail: t("diagnostics.conflictingTwitterModes.detail"),
      settingKey: "legacy_mode",
      quickFix: { secondary_extract_mode: false },
    });
  }

  const hidden = new Set((value(states, "hidden_output_items") as string[]) || []);
  for (const sensitive of ["maturity", "sensitive_media", "adult", "profile_status"]) {
    if (hidden.has(sensitive)) {
      issues.push({
        level: "warning",
        title: t("diagnostics.safetyHidden.title"),
        detail: t("diagnostics.safetyHidden.detail", { item: sensitive }),
        settingKey: "hidden_output_items",
      });
    }
  }

  if (value(states, "booth_adult_display_mode") === "normal") {
    issues.push({
      level: "warning",
      title: t("diagnostics.boothAdultNormal.title"),
      detail: t("diagnostics.boothAdultNormal.detail"),
      settingKey: "booth_adult_display_mode",
      quickFix: { booth_adult_display_mode: "metadata_only" },
    });
  }

  return issues;
}
