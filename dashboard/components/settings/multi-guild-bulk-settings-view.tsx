"use client";

import { Server, Wand2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createTranslator, type DashboardLocale, type TranslationKey } from "@/lib/i18n";

type Guild = {
  guildId: string;
  name: string;
  canManageGuild: boolean;
};

const presets = [
  { labelKey: "settingsCross.preset.quiet", changes: { display_density: "compact", failure_display_policy: "silent", media_display_mode: "thumbnail_only" } },
  { labelKey: "settingsCross.preset.info", changes: { display_density: "detail", failure_display_policy: "source_link", media_display_mode: "embed" } },
  { labelKey: "settingsCross.preset.light", changes: { display_density: "compact", media_display_mode: "link_only", failure_display_policy: "silent" } },
  { labelKey: "settingsCross.preset.admin", changes: { display_density: "detail", failure_display_policy: "error_summary", media_display_mode: "embed" } },
] satisfies Array<{ labelKey: TranslationKey; changes: Record<string, unknown> }>;

export function MultiGuildBulkSettingsView({ guilds, locale }: { guilds: Guild[]; locale: DashboardLocale }) {
  const t = createTranslator(locale);
  const [saving, setSaving] = useState<string | null>(null);
  const blocked = guilds.filter((guild) => !guild.canManageGuild);
  const editableGuilds = guilds.filter((guild) => guild.canManageGuild);

  async function applyPreset(label: string, changes: Record<string, unknown>) {
    if (!editableGuilds.length) return;
    if (!confirm(t("multiBulk.confirm", { label, count: editableGuilds.length }))) return;
    setSaving(label);
    try {
      const responses = await Promise.all(
        editableGuilds.map(async (guild) => {
          const res = await fetch(`/api/guilds/${guild.guildId}/providers/bulk`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ changes }),
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(json.error || t("settingsCross.applyFailed"));
          return json;
        }),
      );
      alert(t("multiBulk.done", { count: responses.length }));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("multiBulk.selectedTitle")}</CardTitle>
          <CardDescription>{t("multiBulk.selectedDescription", { count: guilds.length })}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {guilds.map((guild) => (
            <Badge key={guild.guildId} tone={guild.canManageGuild ? "default" : "warning"}>
              {guild.name}
            </Badge>
          ))}
        </CardContent>
      </Card>

      {blocked.length ? (
        <Card>
          <CardContent className="pt-4 text-sm text-muted-foreground">
            {t("multiBulk.blocked", { count: blocked.length })}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wand2 size={18} />
            {t("settingsCross.presetsTitle")}
          </CardTitle>
          <CardDescription>{t("multiBulk.presetsDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {presets.map((preset) => (
            <Button key={preset.labelKey} variant="outline" disabled={!editableGuilds.length || saving !== null} onClick={() => applyPreset(t(preset.labelKey), preset.changes)}>
              {saving === t(preset.labelKey) ? t("settingsCross.saving") : t(preset.labelKey)}
            </Button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-center gap-3 pt-4 text-sm text-muted-foreground">
          <Server size={16} />
          {t("multiBulk.note")}
        </CardContent>
      </Card>
    </div>
  );
}
