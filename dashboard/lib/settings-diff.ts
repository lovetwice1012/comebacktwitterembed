import type { LocaleText, SettingState, SettingValue } from "@/lib/types";

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

export function labelText(label: LocaleText) {
  if (typeof label === "string") return label;
  return label.ja || label.en || Object.values(label).find(Boolean) || "";
}

export function valueLabel(value: SettingValue | undefined) {
  if (value === undefined) return "default";
  if (value === null) return "unset";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function diffSettings(before: SettingState[], after: SettingState[]) {
  const beforeByKey = new Map(before.map((setting) => [setting.key, setting]));
  return after
    .map((next) => {
      const prev = beforeByKey.get(next.key);
      if (!prev || deepEqual(prev.value, next.value)) return null;
      return {
        key: next.key,
        label: labelText(next.spec.label),
        before: prev.value,
        after: next.value,
        defaultValue: next.defaultValue,
        impactLevel: next.spec.impactLevel || "low",
        category: next.spec.category || "provider専用",
      };
    })
    .filter(Boolean);
}
