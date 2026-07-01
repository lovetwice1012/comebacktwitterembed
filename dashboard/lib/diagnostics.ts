import type { SettingState } from "@/lib/types";

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

export function diagnoseProvider(providerId: string, states: SettingState[]): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];

  if (value(states, "enabled") !== true) {
    issues.push({
      level: "info",
      title: "Provider is disabled",
      detail: "URLs for this provider are not expanded in this guild.",
      settingKey: "enabled",
      quickFix: { enabled: true },
    });
  }

  if (value(states, "media_display_mode") === "attachment") {
    issues.push({
      level: ["instagram", "pixiv", "tiktok", "booth"].includes(providerId) ? "warning" : "notice",
      title: "Attachment media mode",
      detail: "Busy media channels can become heavier when files are attached directly.",
      settingKey: "media_display_mode",
      quickFix: { media_display_mode: "embed" },
    });
  }

  if (value(states, "failure_display_policy") === "error_summary") {
    issues.push({
      level: "notice",
      title: "Error summaries are visible",
      detail: "Useful for administrators, but noisy in normal channels.",
      settingKey: "failure_display_policy",
      quickFix: { failure_display_policy: "source_link" },
    });
  }

  if (providerId === "twitter" && value(states, "quote_repost_max_depth") === 0) {
    issues.push({
      level: "danger",
      title: "Unlimited quote depth",
      detail: "Deep quote chains can create spam-like follow-up output.",
      settingKey: "quote_repost_max_depth",
      quickFix: { quote_repost_max_depth: "2" },
    });
  }

  if (value(states, "legacy_mode") === true && value(states, "secondary_extract_mode") === true) {
    issues.push({
      level: "danger",
      title: "Conflicting Twitter modes",
      detail: "legacy_mode and secondary_extract_mode are mutually exclusive.",
      settingKey: "legacy_mode",
      quickFix: { secondary_extract_mode: false },
    });
  }

  const hidden = new Set((value(states, "hidden_output_items") as string[]) || []);
  for (const sensitive of ["maturity", "sensitive_media", "adult", "profile_status"]) {
    if (hidden.has(sensitive)) {
      issues.push({
        level: "warning",
        title: "Safety-related output is hidden",
        detail: `${sensitive} is hidden. Confirm this matches moderation expectations.`,
        settingKey: "hidden_output_items",
      });
    }
  }

  if (value(states, "booth_adult_display_mode") === "normal") {
    issues.push({
      level: "warning",
      title: "Booth adult media displays normally",
      detail: "Confirm this does not conflict with server rules.",
      settingKey: "booth_adult_display_mode",
      quickFix: { booth_adult_display_mode: "metadata_only" },
    });
  }

  return issues;
}
