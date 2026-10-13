import { valueLabel, type DashboardLocale } from "@/lib/i18n";
import { settingDisplayValue, settingTitle } from "@/components/settings/settings-presentation";
import type { ProviderCatalogItem, SettingSpec, SettingState, SettingValue } from "@/lib/types";

type Data = Record<string, unknown>;
export type AuditChange = { key: string; label: string; before: string; after: string };
export type AuditHistoryEntry = {
  id: string; action: string; actionLabel: string; providerId: string; providerLabel: string;
  actor: string; actorId: string; time: string; changes: AuditChange[];
  facts: Array<{ label: string; value: string }>; details: unknown;
};
const object = (value: unknown): Data => value && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const sensitiveKey = /password|passwd|secret|credential|authorization|cookie|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|(^|[_-])token($|[_-])/i;
const privateQuery = /token|key|signature|credential|policy|authorization|auth|x-amz|x-goog|^sig$|hmac/i;

/** Redact before serializing a history entry to the browser, including optional details. */
export function redactAuditValue(value: unknown, key = ""): unknown {
  if (sensitiveKey.test(key)) return "••••";
  if (Array.isArray(value)) return value.map(item => redactAuditValue(item));
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactAuditValue(item, name)]));
  }
  if (typeof value !== "string") return value;
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, raw => {
    try {
      const url = new URL(raw); url.username = ""; url.password = "";
      for (const name of [...url.searchParams.keys()]) if (privateQuery.test(name)) url.searchParams.set(name, "••••");
      url.pathname = url.pathname.replace(/(\/api(?:\/v\d+)?\/webhooks\/\d+\/)[^/]+/i, "$1••••");
      return url.toString();
    } catch { return raw; }
  });
}

const labels: Record<string, [string, string]> = {
  "setting.update": ["設定を変更", "Setting changed"], "setting.set": ["設定を変更", "Setting changed"],
  "settings.change": ["設定を変更", "Settings changed"], "settings.reset": ["設定を初期値へ戻した", "Settings reset"],
  "settings.copy": ["別サーバーから設定をコピー", "Settings copied from another server"],
  "provider.reset": ["サービスの設定を初期値へ戻した", "Service settings reset"],
  "guild.sync": ["別サーバーから設定をコピー", "Settings copied from another server"],
};
function asState(key: string, spec: SettingSpec | undefined): SettingState | undefined {
  return spec ? { key, kind: spec.kind, spec, value: null, rawValue: undefined, defaultValue: undefined, customized: false, changedFromDefault: false, warnings: [] } : undefined;
}
function displayValue(value: unknown, key: string, spec: SettingSpec | undefined, locale: DashboardLocale) {
  const safe = redactAuditValue(value, key);
  if (safe === undefined) return locale === "ja" ? "記録なし" : "Not recorded";
  if (typeof safe === "boolean") return locale === "ja" ? safe ? "有効" : "無効" : safe ? "On" : "Off";
  if (safe && typeof safe === "object" && !Array.isArray(safe) && !spec) return locale === "ja" ? `${Object.keys(safe).length}項目` : `${Object.keys(safe).length} items`;
  return settingDisplayValue(asState(key, spec), safe as SettingValue, locale);
}
function title(key: string, spec: SettingSpec | undefined, locale: DashboardLocale) {
  const state = asState(key, spec);
  return state ? settingTitle(state, locale) : locale === "ja" ? "その他の設定" : "Other setting";
}

export function presentAuditEntry(value: unknown, catalog: ProviderCatalogItem[], locale: DashboardLocale): AuditHistoryEntry {
  const log = object(value), ja = locale === "ja", action = String(log.action || ""), providerId = String(log.providerId || "");
  const provider = catalog.find(item => item.providerId === providerId);
  const specFor = (key: string) => provider?.settings.find(spec => spec.key === key);
  const defaultLabel = ja ? "初期値を使用" : "Use default";
  const changes: AuditChange[] = [];
  const facts: AuditHistoryEntry["facts"] = [];
  const addChange = (key: string, before: unknown, after: unknown, inherited = false, capturedSpec?: SettingSpec) => {
    const spec = specFor(key) || capturedSpec;
    changes.push({ key, label: title(key, spec, locale), before: displayValue(before, key, spec, locale), after: inherited ? defaultLabel : displayValue(after, key, spec, locale) });
  };
  if (["setting.update", "setting.set"].includes(action) && log.settingKey) {
    addChange(String(log.settingKey), log.before, log.after, action === "setting.update" && log.after === null);
  } else if (["settings.change", "settings.reset", "settings.copy"].includes(action)) {
    const before = object(log.before), after = object(log.after);
    const named = String(log.settingKey || "").split(",").filter(key => key && (Object.hasOwn(before, key) || Object.hasOwn(after, key)));
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    for (const key of keys) if (named.includes(key) || JSON.stringify(before[key]) !== JSON.stringify(after[key])) addChange(key, before[key], after[key]);
  } else if (action === "provider.reset" && Array.isArray(log.before)) {
    for (const item of log.before) {
      const state = object(item), key = String(state.key || "");
      if (!key || state.kind === "overview" || !(state.customized || state.changedFromDefault)) continue;
      const spec = object(state.spec) as SettingSpec;
      addChange(key, state.value, state.defaultValue, state.defaultValue === undefined, spec.label ? spec : undefined);
    }
  } else if (action === "guild.sync") {
    const summary = object(log.after), source = object(log.before);
    facts.push({ label: ja ? "コピー元サーバー" : "Source server", value: String(summary.sourceGuildId || source.sourceGuildId || (ja ? "記録なし" : "Not recorded")) });
    for (const [key, label] of [["providerCount", ja ? "サービス数" : "Services"], ["copied", ja ? "コピーした設定" : "Settings copied"], ["skippedTargets", ja ? "コピーしなかったチャンネル・ロール指定" : "Channel and role targets excluded"]]) {
      if (summary[key] !== undefined) facts.push({ label, value: valueLabel(redactAuditValue(summary[key], key) as SettingValue, locale) });
    }
  }
  const createdAt = log.createdAt instanceof Date ? log.createdAt : new Date(log.createdAt as string | number);
  const actorId = String(log.actorUserId || ""), snapshotName = String(log.actorUsernameSnapshot || "");
  const actor = snapshotName.startsWith("admin-support:") ? ja ? "運営管理" : "Administration" : snapshotName || (actorId === "system" ? ja ? "システム" : "System" : actorId ? `${ja ? "ユーザー" : "User"} ${actorId}` : ja ? "操作した人の記録なし" : "Actor not recorded");
  return {
    id: String(log.auditLogId || ""), action, actionLabel: labels[action]?.[ja ? 0 : 1] || (ja ? "管理操作" : "Management action"),
    providerId, providerLabel: provider?.label || (providerId ? ja ? "その他のサービス" : "Other service" : ""),
    actor, actorId,
    time: Number.isNaN(createdAt.getTime()) ? ja ? "日時の記録なし" : "Date not recorded" : new Intl.DateTimeFormat(ja ? "ja-JP" : "en", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" }).format(createdAt),
    changes, facts, details: redactAuditValue(log),
  };
}
