import type { LocaleText, SettingState, SettingValue } from "@/lib/types";
import { categoryLabel, labelText as localizedLabelText, type DashboardLocale, valueLabel as localizedValueLabel } from "@/lib/i18n";

export function deepEqual(a: unknown, b: unknown) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, val]) => [key, stable(val)]),
    );
  }
  return value;
}

export function labelText(label: LocaleText, locale: DashboardLocale = "ja") {
  return localizedLabelText(label, locale);
}

export function valueLabel(value: SettingValue | undefined, locale: DashboardLocale = "ja") {
  return localizedValueLabel(value, locale);
}

export function diffSettings(before: SettingState[], after: SettingState[], locale: DashboardLocale = "ja") {
  const beforeByKey = new Map(before.map((setting) => [setting.key, setting]));
  return after
    .map((next) => {
      const prev = beforeByKey.get(next.key);
      if (!prev || deepEqual(prev.value, next.value)) return null;
      return {
        key: next.key,
        label: labelText(next.spec.label, locale),
        before: prev.value,
        after: next.value,
        defaultValue: next.defaultValue,
        impactLevel: next.spec.impactLevel || "low",
        category: categoryLabel(next.spec.category, locale),
      };
    })
    .filter(Boolean);
}
