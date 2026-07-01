"use client";

import { Search, Wand2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { labelText, valueLabel } from "@/lib/settings-diff";
import type { SettingState } from "@/lib/types";

type Item = {
  providerId: string;
  providerLabel: string;
  setting: SettingState;
};

const presets = [
  { label: "静かな運用", changes: { display_density: "compact", failure_display_policy: "silent", media_display_mode: "thumbnail_only" } },
  { label: "情報量多め", changes: { display_density: "detail", failure_display_policy: "source_link", media_display_mode: "embed" } },
  { label: "軽量運用", changes: { display_density: "compact", media_display_mode: "link_only", failure_display_policy: "silent" } },
  { label: "管理者向け検証", changes: { display_density: "detail", failure_display_policy: "error_summary", media_display_mode: "embed" } },
];

export function CrossSettingsView({ guildId, items, canManage }: { guildId: string; items: Item[]; canManage: boolean }) {
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
        labelText(setting.spec.label),
        labelText(setting.spec.description),
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [items, query]);

  async function applyPreset(label: string, changes: Record<string, unknown>) {
    if (!confirm(`${label} を全providerへ適用します。保存前に各providerで差分が監査ログへ記録されます。`)) return;
    setSaving(label);
    try {
      const res = await fetch(`/api/guilds/${guildId}/providers/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Preset failed");
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
            設定プリセット
          </CardTitle>
          <CardDescription>display_density / media_display_mode / failure_display_policy を一括変更します。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {presets.map((preset) => (
            <Button key={preset.label} variant="outline" disabled={!canManage || saving !== null} onClick={() => applyPreset(preset.label, preset.changes)}>
              {saving === preset.label ? "保存中" : preset.label}
            </Button>
          ))}
        </CardContent>
      </Card>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-3 text-muted-foreground" size={16} />
        <Input className="pl-9" placeholder="動画, メディア, 削除, 匿名, 失敗, 説明文, 引用, タグ..." value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>

      <div className="space-y-2">
        {filtered.map(({ providerId, providerLabel, setting }) => (
          <Link key={`${providerId}:${setting.key}`} href={`/dashboard/${guildId}/providers/${providerId}`} className="block">
            <Card className="transition hover:border-primary">
              <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-4">
                <div className="min-w-0">
                  <div className="font-medium">{labelText(setting.spec.label)}</div>
                  <div className="truncate text-sm text-muted-foreground">{providerLabel} · {setting.key} · {setting.spec.dbColumn || "-"}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge tone={setting.spec.impactLevel === "danger" ? "danger" : setting.spec.impactLevel === "high" ? "warning" : "muted"}>{setting.spec.impactLevel}</Badge>
                  <Badge tone={setting.changedFromDefault ? "warning" : "muted"}>{setting.changedFromDefault ? "changed" : "default"}</Badge>
                  <Badge tone="muted">{valueLabel(setting.value)}</Badge>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
