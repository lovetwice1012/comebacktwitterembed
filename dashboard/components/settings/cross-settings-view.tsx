"use client";

import { Search, Wand2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { categoryLabel, createTranslator, impactLabel, labelText, type DashboardLocale, type TranslationKey, valueLabel } from "@/lib/i18n";
import type { SettingState } from "@/lib/types";

type Item = {
  providerId: string;
  providerLabel: string;
  setting: SettingState;
};

const presets = [
  { labelKey: "settingsCross.preset.quiet", changes: { display_density: "compact", failure_display_policy: "silent", media_display_mode: "thumbnail_only" } },
  { labelKey: "settingsCross.preset.info", changes: { display_density: "detail", failure_display_policy: "source_link", media_display_mode: "embed" } },
  { labelKey: "settingsCross.preset.light", changes: { display_density: "compact", media_display_mode: "link_only", failure_display_policy: "silent" } },
  { labelKey: "settingsCross.preset.admin", changes: { display_density: "detail", failure_display_policy: "error_summary", media_display_mode: "embed" } },
] satisfies Array<{ labelKey: TranslationKey; changes: Record<string, unknown> }>;

export function CrossSettingsView({ guildId, items, canManage, locale }: { guildId: string; items: Item[]; canManage: boolean; locale: DashboardLocale }) {
  const t = createTranslator(locale);
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(({ providerId, providerLabel, setting }) => {
      const haystack = [
        providerId,
        providerLabel,
        setting.key,
        setting.spec.dbColumn,
        setting.spec.category,
        categoryLabel(setting.spec.category, locale),
        labelText(setting.spec.label, locale),
        labelText(setting.spec.description, locale),
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [items, query]);

  async function applyPreset(label: string, changes: Record<string, unknown>) {
    if (!confirm(t("settingsCross.applyConfirm", { label }))) return;
    setSaving(label);
    try {
      const res = await fetch(`/api/guilds/${guildId}/providers/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("settingsCross.applyFailed"));
      router.refresh();
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wand2 size={18} />
            {t("settingsCross.presetsTitle")}
          </CardTitle>
          <CardDescription>{t("settingsCross.presetsDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {presets.map((preset) => (
            <Button key={preset.labelKey} variant="outline" disabled={!canManage || saving !== null} onClick={() => applyPreset(t(preset.labelKey), preset.changes)}>
              {saving === t(preset.labelKey) ? t("settingsCross.saving") : t(preset.labelKey)}
            </Button>
          ))}
        </CardContent>
      </Card>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-3 text-muted-foreground" size={16} />
        <Input className="pl-9" placeholder={t("settingsCross.searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>

      <div className="space-y-2">
        {filtered.map(({ providerId, providerLabel, setting }) => (
          <Link key={`${providerId}:${setting.key}`} href={`/dashboard/${guildId}/providers/${providerId}`} className="block">
            <Card className="transition hover:border-primary">
              <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-4">
                <div className="min-w-0">
                  <div className="font-medium">{labelText(setting.spec.label, locale)}</div>
                  <div className="truncate text-sm text-muted-foreground">{providerLabel} · {setting.key} · {setting.spec.dbColumn || "-"}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge tone={setting.spec.impactLevel === "danger" ? "danger" : setting.spec.impactLevel === "high" ? "warning" : "muted"}>{impactLabel(setting.spec.impactLevel, locale)}</Badge>
                  <Badge tone={setting.changedFromDefault ? "warning" : "muted"}>{setting.changedFromDefault ? t("state.changed") : t("state.default")}</Badge>
                  <Badge tone="muted">{valueLabel(setting.value, locale)}</Badge>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
