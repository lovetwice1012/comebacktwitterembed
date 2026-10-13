"use client";

import { Check, ChevronRight, Layers3, LockKeyhole, Search, Wand2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { categoryLabel, createTranslator, impactLabel, labelText, valueLabel, type DashboardLocale, type TranslationKey } from "@/lib/i18n";
import type { SettingState, SettingValue } from "@/lib/types";
import { SettingsSaveResults, useSettingsBatch } from "./settings-save-results";
import { isCommonSetting, settingChoiceTitle, settingTitle } from "./settings-presentation";
import "./settings-workspace.css";

type Item = {
  providerId: string;
  providerLabel: string;
  setting: SettingState;
};

function settingValueText(setting: SettingState, locale: DashboardLocale) {
  const choice = setting.spec.choices?.find(item => String(item.value) === String(setting.value));
  if (choice) return settingChoiceTitle(setting, String(setting.value), locale);
  if (setting.kind === "targets" && setting.value && typeof setting.value === "object") {
    const count = Object.values(setting.value).reduce<number>((total, value) => total + (Array.isArray(value) ? value.length : 0), 0);
    return locale === "ja" ? `${count}件指定` : `${count} targets`;
  }
  if (setting.kind === "buttonVisibility" && setting.value && typeof setting.value === "object") {
    const count = Object.values(setting.value).filter(value => value === true).length;
    return locale === "ja" ? `${count}個を非表示` : `${count} buttons hidden`;
  }
  if (setting.kind === "accountDepthMap" && setting.value && typeof setting.value === "object") {
    const count = Object.keys(setting.value).length;
    return locale === "ja" ? `${count}アカウント` : `${count} accounts`;
  }
  if (Array.isArray(setting.value)) return locale === "ja" ? `${setting.value.length}項目` : `${setting.value.length} items`;
  return valueLabel(setting.value, locale);
}

const presets = [
  { labelKey: "settingsCross.preset.quiet", changes: { display_density: "compact", failure_display_policy: "silent", media_display_mode: "thumbnail_only" } },
  { labelKey: "settingsCross.preset.info", changes: { display_density: "detail", failure_display_policy: "source_link", media_display_mode: "embed" } },
  { labelKey: "settingsCross.preset.light", changes: { display_density: "compact", media_display_mode: "link_only", failure_display_policy: "silent" } },
  { labelKey: "settingsCross.preset.admin", changes: { display_density: "detail", failure_display_policy: "error_summary", media_display_mode: "embed" } },
] satisfies Array<{ labelKey: TranslationKey; changes: Record<string, unknown> }>;

export function CrossSettingsView({
  guildId,
  items,
  canManage,
  locale,
  onSaved,
  viewerId,
  guildName,
}: {
  guildId: string;
  items: Item[];
  canManage: boolean;
  locale: DashboardLocale;
  onSaved?: () => void;
  viewerId?: string;
  guildName?: string;
}) {
  const t = createTranslator(locale);
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("common"), [providerFilter, setProviderFilter] = useState("all");
  const [customizedOnly, setCustomizedOnly] = useState(false), [selectedPreset, setSelectedPreset] = useState<number | null>(null);
  useEffect(() => { if (new URLSearchParams(window.location.search).get("changed") === "1") { setCustomizedOnly(true); setCategory("all"); } }, [guildId]);
  const batch = useSettingsBatch(locale, `${viewerId || "fixture"}:${guildId}`);
  const saving = batch.busy ? batch.plan?.label : null;
  const providers = useMemo(() => [...new Map(items.map(item => [item.providerId, item.providerLabel])).entries()], [items]);
  const categories = [...new Set(items.map(item => item.setting.spec.category).filter(Boolean))];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(({ providerId, providerLabel, setting }) => {
      if (providerFilter !== "all" && providerId !== providerFilter) return false;
      if (customizedOnly && !setting.changedFromDefault) return false;
      if (!q && category === "common" && !isCommonSetting(setting, items.filter(item => item.providerId === providerId).map(item => item.setting))) return false;
      if (category !== "all" && category !== "common" && category !== setting.spec.category) return false;
      const haystack = [
        providerId,
        providerLabel,
        setting.key,
        setting.spec.dbColumn,
        setting.spec.category,
        categoryLabel(setting.spec.category, locale),
        labelText(setting.spec.label, locale),
        settingTitle(setting, locale),
        labelText(setting.spec.description, locale),
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [items, query, locale, providerFilter, customizedOnly, category]);
  const groups = providers.map(([providerId, providerLabel]) => ({ providerId, providerLabel, items: filtered.filter(item => item.providerId === providerId) })).filter(group => group.items.length);
  const preset = selectedPreset === null ? null : presets[selectedPreset];
  const presetValues = (changes: Record<string, unknown>) => Object.entries(changes).map(([key, value]) => {
    const setting = items.find(item => item.setting.key === key)?.setting;
    if (setting) return { title: settingTitle(setting, locale), value: settingChoiceTitle(setting, String(value), locale) };
    const labels = {
      display_density: [locale === "ja" ? "表示する情報量" : "Amount of detail", value === "compact" ? locale === "ja" ? "少なめ" : "Less detail" : locale === "ja" ? "詳しく" : "More detail"],
      media_display_mode: [locale === "ja" ? "画像・動画" : "Images and videos", value === "embed" ? locale === "ja" ? "本文と一緒に表示" : "Show with the message" : value === "link_only" ? locale === "ja" ? "リンクだけ表示" : "Show links only" : locale === "ja" ? "小さな画像だけ表示" : "Show a small image"],
      failure_display_policy: [locale === "ja" ? "取得できないとき" : "Fetch failures", value === "silent" ? locale === "ja" ? "何も送らない" : "Send nothing" : value === "source_link" ? locale === "ja" ? "元リンクを送る" : "Send source link" : locale === "ja" ? "短いエラーを送る" : "Send a short error"],
    } as Record<string, string[]>;
    return { title: labels[key]?.[0] || key, value: labels[key]?.[1] || String(value) };
  });

  async function applyPreset(label: string, changes: Record<string, unknown>) {
    const results = await batch.run({ kind: "preset", label, changes: changes as Record<string, SettingValue>, targets: [{ guildId, name: guildName || (locale === "ja" ? "このサーバー" : "This server") }] });
    if (results.length && results.every(result => result.status === "saved")) { setSelectedPreset(null); if (onSaved) onSaved(); else router.refresh(); }
  }

  async function retry() {
    if (!batch.plan) return;
    const results = await batch.run(batch.plan, true);
    if (results.length && results.every(result => result.status === "saved")) { if (onSaved) onSaved(); else router.refresh(); }
  }

  return (
    <div className="space-y-4">
      <details className="rounded-lg border bg-card p-4">
        <summary className="flex cursor-pointer items-center gap-2 font-semibold"><Wand2 size={18} aria-hidden="true" />{locale === "ja" ? "全サービスの表示をまとめて変更" : "Change display for all services"}</summary>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {presets.map((item, index) => <Button key={item.labelKey} className="settings-preset-choice" variant={selectedPreset === index ? "default" : "outline"} aria-label={locale === "ja" ? `${t(item.labelKey)}を確認` : `Review ${t(item.labelKey)}`} aria-pressed={selectedPreset === index} disabled={!canManage || saving !== null} onClick={() => setSelectedPreset(index)}><span className="font-semibold">{t(item.labelKey)}</span><span className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-normal opacity-80">{presetValues(item.changes).map(field => <span key={field.title}>{field.value}</span>)}</span></Button>)}
        </div>
      {preset ? <section aria-label={locale === "ja" ? "表示変更の確認" : "Review display changes"} className="mt-4 space-y-3 rounded-lg border p-4">
        <div className="flex items-start justify-between gap-2"><h2 className="font-semibold">{t(preset.labelKey)}</h2><Button size="sm" variant="ghost" disabled={!!saving} aria-label={locale === "ja" ? "適用を取り消す" : "Cancel preset"} onClick={() => setSelectedPreset(null)}><X size={16} aria-hidden="true" /></Button></div>
        <p className="flex items-start gap-2 text-sm"><Layers3 size={16} className="mt-0.5 shrink-0" aria-hidden="true" />{locale === "ja" ? `${guildName || "このサーバー"}の全サービス` : `All services in ${guildName || "this server"}`}</p>
        <dl className="space-y-2">{presetValues(preset.changes).map(field => <div key={field.title} className="flex flex-wrap justify-between gap-2 rounded bg-muted p-2 text-sm"><dt className="text-muted-foreground">{field.title}</dt><dd className="font-medium">{field.value}</dd></div>)}</dl>
        <Button className="min-h-11" disabled={!canManage || saving !== null} onClick={() => void applyPreset(t(preset.labelKey), preset.changes)}><Check size={16} aria-hidden="true" />{saving ? t("settingsCross.saving") : locale === "ja" ? "全サービスに適用" : "Apply to all services"}</Button>
      </section> : null}
      </details>

      {batch.plan && <SettingsSaveResults label={batch.plan.label} results={batch.results} busy={batch.busy} locale={locale} onRetry={() => void retry()} />}
      {!canManage && <p className="flex items-start gap-2 text-sm text-muted-foreground"><LockKeyhole size={16} className="mt-0.5 shrink-0" aria-hidden="true" />{locale === "ja" ? "一括適用にはサーバー管理権限が必要" : "Manage Server permission required for bulk changes"}</p>}

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-3 text-muted-foreground" size={16} />
        <Input aria-label={t("settingsCross.searchPlaceholder")} className="pl-9" placeholder={t("settingsCross.searchPlaceholder")} value={query} onChange={(event) => { setQuery(event.target.value); setCategory("all"); }} />
      </div>
      <div className="flex flex-wrap gap-3"><label className="flex min-h-11 items-center gap-2 text-sm">{locale === "ja" ? "サービス" : "Service"}<select className="min-h-11 min-w-0 rounded border bg-card px-2" value={providerFilter} onChange={event => setProviderFilter(event.target.value)}><option value="all">{locale === "ja" ? "すべて" : "All"}</option>{providers.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label className="flex min-h-11 items-center gap-2 text-sm">{locale === "ja" ? "設定の種類" : "Category"}<select className="min-h-11 min-w-0 rounded border bg-card px-2" value={category} onChange={event => setCategory(event.target.value)}><option value="common">{locale === "ja" ? "よく使う設定" : "Common settings"}</option><option value="all">{locale === "ja" ? "すべて" : "All"}</option>{categories.map(item => <option key={item} value={item}>{categoryLabel(item, locale)}</option>)}</select></label><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={customizedOnly} onChange={event => setCustomizedOnly(event.target.checked)} />{locale === "ja" ? "初期値から変更した設定だけ" : "Customized settings only"}</label></div>
      <p role="status" className="text-xs text-muted-foreground">{locale === "ja" ? `${filtered.length}件 · ${groups.length}サービス` : `${filtered.length} settings · ${groups.length} services`}</p>

      <div className="space-y-2">
        {!filtered.length && (query || providerFilter !== "all" || category !== "common" || customizedOnly) ? <div className="space-y-3 rounded-md border bg-card p-5"><p className="text-sm text-muted-foreground">{locale === "ja" ? "検索結果はありません" : "No matching settings"}</p><Button variant="outline" onClick={() => { setQuery(""); setProviderFilter("all"); setCategory("common"); setCustomizedOnly(false); }}>{locale === "ja" ? "検索条件をクリア" : "Clear filters"}</Button></div> : null}
        {groups.map(group => <details key={group.providerId} open={!!query || providerFilter !== "all" || category !== "common" || customizedOnly} className="overflow-hidden rounded-lg border bg-card"><summary className="cursor-pointer px-4 py-3 font-semibold">{group.providerLabel}<span className="ml-3 text-xs font-normal text-muted-foreground">{locale === "ja" ? `${group.items.length}件` : `${group.items.length} settings`}</span></summary>
        {group.items.map(({ providerId, setting }) => (
          <Link key={`${providerId}:${setting.key}`} href={`/dashboard/${guildId}/providers/${providerId}?setting=${encodeURIComponent(setting.key)}`} className="settings-result-row">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{settingTitle(setting, locale)}</div>
                  <div className="mt-1 break-words text-xs text-muted-foreground">{settingValueText(setting, locale)}</div>
                </div>
                <div className="flex items-center gap-2">
                  {setting.spec.impactLevel === "danger" || setting.spec.impactLevel === "high" ? (
                    <Badge tone={setting.spec.impactLevel === "danger" ? "danger" : "warning"}>{impactLabel(setting.spec.impactLevel, locale)}</Badge>
                  ) : null}
                  {setting.changedFromDefault ? <Badge tone="warning">{t("state.changed")}</Badge> : null}
                  <ChevronRight size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                </div>
          </Link>
        ))}</details>)}
      </div>
    </div>
  );
}
