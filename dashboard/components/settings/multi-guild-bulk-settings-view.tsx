"use client";

import { Layers3, Server, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ProviderSettingsForm } from "@/components/settings/provider-settings-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createTranslator, type DashboardLocale, type TranslationKey } from "@/lib/i18n";
import type { SettingState, SettingValue } from "@/lib/types";

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

type ProviderOverview = {
  providerId: string;
  label: string;
};

export function MultiGuildBulkSettingsView({ guilds, locale }: { guilds: Guild[]; locale: DashboardLocale }) {
  const t = createTranslator(locale);
  const [saving, setSaving] = useState<string | null>(null);
  const blocked = guilds.filter((guild) => !guild.canManageGuild);
  const editableGuilds = guilds.filter((guild) => guild.canManageGuild);
  const baselineGuild = editableGuilds[0];
  const [providers, setProviders] = useState<ProviderOverview[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [providerSettings, setProviderSettings] = useState<SettingState[]>([]);
  const [loadingProvider, setLoadingProvider] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const selectedProvider = useMemo(() => providers.find((provider) => provider.providerId === selectedProviderId), [providers, selectedProviderId]);

  useEffect(() => {
    if (!baselineGuild) {
      setProviders([]);
      setSelectedProviderId("");
      return;
    }
    let active = true;
    fetch(`/api/guilds/${baselineGuild.guildId}/providers`, { headers: { Accept: "application/json" } })
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error || t("settingsCross.applyFailed"));
        return json as ProviderOverview[];
      })
      .then((items) => {
        if (!active) return;
        setProviders(items);
        setSelectedProviderId((current) => current || items[0]?.providerId || "");
      })
      .catch((error) => {
        if (active) setProviderError(error instanceof Error ? error.message : t("settingsCross.applyFailed"));
      });
    return () => {
      active = false;
    };
  }, [baselineGuild?.guildId]);

  useEffect(() => {
    if (!baselineGuild || !selectedProviderId) {
      setProviderSettings([]);
      return;
    }
    let active = true;
    setLoadingProvider(true);
    setProviderError(null);
    fetch(`/api/guilds/${baselineGuild.guildId}/providers/${selectedProviderId}/settings`, { headers: { Accept: "application/json" } })
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error || t("settingsCross.applyFailed"));
        return json.settings as SettingState[];
      })
      .then((settings) => {
        if (active) setProviderSettings(settings.filter((setting) => setting.kind !== "targets"));
      })
      .catch((error) => {
        if (active) setProviderError(error instanceof Error ? error.message : t("settingsCross.applyFailed"));
      })
      .finally(() => {
        if (active) setLoadingProvider(false);
      });
    return () => {
      active = false;
    };
  }, [baselineGuild?.guildId, selectedProviderId]);

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

  async function applyProviderChanges(changes: Record<string, SettingValue>) {
    if (!selectedProviderId || !editableGuilds.length || !selectedProvider) return;
    if (!confirm(t("multiBulk.detailConfirm", { provider: selectedProvider.label, count: editableGuilds.length }))) {
      throw new Error(t("multiBulk.cancelled"));
    }
    const warningSet = new Set<string>();
    const responses = await Promise.all(
      editableGuilds.map(async (guild) => {
        const res = await fetch(`/api/guilds/${guild.guildId}/providers/${selectedProviderId}/settings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ changes }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || t("settingsCross.applyFailed"));
        for (const warning of json.warnings || []) warningSet.add(String(warning));
        return json;
      }),
    );
    return {
      warnings: [
        t("multiBulk.detailDone", { count: responses.length }),
        ...warningSet,
      ],
    };
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
        <CardContent className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {presets.map((preset) => (
            <Button className="w-full sm:w-auto" key={preset.labelKey} variant="outline" disabled={!editableGuilds.length || saving !== null} onClick={() => applyPreset(t(preset.labelKey), preset.changes)}>
              {saving === t(preset.labelKey) ? t("settingsCross.saving") : t(preset.labelKey)}
            </Button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-start gap-3 pt-4 text-sm text-muted-foreground">
          <Server size={16} />
          <span className="min-w-0 break-words">{t("multiBulk.note")}</span>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold leading-tight">
            <Layers3 size={18} />
            {t("multiBulk.detailTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("multiBulk.detailDescription")}</p>
        </div>
        <div className="space-y-3">
          {baselineGuild ? (
            <>
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <label className="space-y-1 text-sm">
                  <span className="font-medium">{t("multiBulk.provider")}</span>
                  <select
                    className="h-10 w-full min-w-0 rounded-md border bg-card px-3 text-sm"
                    value={selectedProviderId}
                    onChange={(event) => setSelectedProviderId(event.target.value)}
                  >
                    {providers.map((provider) => (
                      <option key={provider.providerId} value={provider.providerId}>{provider.label}</option>
                    ))}
                  </select>
                </label>
                <div className="space-y-1 text-sm">
                  <div className="font-medium">{t("multiBulk.baseline")}</div>
                  <div className="min-w-0 break-words rounded-md border bg-muted px-3 py-2">{baselineGuild.name}</div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t("multiBulk.detailTargetsNote")}</p>
              {providerError ? <div className="rounded-md border bg-card p-3 text-sm text-destructive">{providerError}</div> : null}
              {loadingProvider ? <div className="rounded-md border bg-card p-3 text-sm text-muted-foreground">{t("shell.guildSwitcher.loading")}</div> : null}
              {!loadingProvider && selectedProvider && providerSettings.length ? (
                <ProviderSettingsForm
                  key={`${baselineGuild.guildId}:${selectedProviderId}`}
                  guildId={baselineGuild.guildId}
                  providerId={selectedProviderId}
                  providerLabel={selectedProvider.label}
                  canEdit={editableGuilds.length > 0}
                  settings={providerSettings}
                  locale={locale}
                  draftKeyOverride={`dashboard:bulk-draft:${selectedProviderId}:${editableGuilds.map((guild) => guild.guildId).join(",")}`}
                  onSaveChanges={applyProviderChanges}
                  showResetProvider={false}
                />
              ) : null}
            </>
          ) : (
            <div className="text-sm text-muted-foreground">{t("multiBulk.noEditable")}</div>
          )}
        </div>
      </section>
    </div>
  );
}
