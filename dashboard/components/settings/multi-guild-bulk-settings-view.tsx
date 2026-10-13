"use client";

import { Info, Layers3, LockKeyhole, Server, Wand2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProviderSettingsForm } from "@/components/settings/provider-settings-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createTranslator, type DashboardLocale, type TranslationKey } from "@/lib/i18n";
import type { SettingState, SettingValue } from "@/lib/types";
import { deepEqual } from "@/lib/settings-diff";
import { SettingsSaveResults, useSettingsBatch } from "./settings-save-results";

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

export function MultiGuildBulkSettingsView({ guilds, locale, viewerId }: { guilds: Guild[]; locale: DashboardLocale; viewerId?: string }) {
  const t = createTranslator(locale);
  const scopeKey = guilds.map(guild => `${guild.guildId}:${guild.canManageGuild}`).sort().join(",");
  const viewerScope = `${viewerId || "fixture"}:${scopeKey}`;
  const batch = useSettingsBatch(locale, viewerScope);
  const saving = batch.busy ? batch.plan?.label : null;
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [draftChanges, setDraftChanges] = useState<Record<string, SettingValue>>({});
  const receiveChanges = useCallback((changes: Record<string, SettingValue>) => setDraftChanges(current => deepEqual(current, changes) ? current : changes), []);
  const savedSequence = useRef(0);
  const [externalSaved, setExternalSaved] = useState<{ sequence: number; changes: Record<string, SettingValue>; warnings?: string[]; scopeKey: string; providerId: string }>();
  const [pendingIntent, setPendingIntent] = useState<{ scope: string; providerId: string; keys: string[] }>();
  const [pendingStorageWarning, setPendingStorageWarning] = useState(false);
  const blocked = guilds.filter((guild) => !guild.canManageGuild);
  const editableGuilds = guilds.filter((guild) => guild.canManageGuild);
  const baselineGuild = editableGuilds[0];
  const [providers, setProviders] = useState<ProviderOverview[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [providerSettings, setProviderSettings] = useState<SettingState[]>([]);
  const [settingsProviderId, setSettingsProviderId] = useState("");
  const [settingsGuildId, setSettingsGuildId] = useState("");
  const [loadingProvider, setLoadingProvider] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const selectedProvider = useMemo(() => providers.find((provider) => provider.providerId === selectedProviderId), [providers, selectedProviderId]);
  const pendingDraftKey = selectedProviderId ? `dashboard:bulk-pending:${viewerId || "fixture"}:${selectedProviderId}:${editableGuilds.map(guild => guild.guildId).sort().join(",")}` : null;
  useEffect(() => {
    if (!pendingDraftKey) { setPendingIntent(undefined); return; }
    try {
      const raw = window.localStorage.getItem(pendingDraftKey);
      const parsed = raw ? JSON.parse(raw) : [];
      const keys = Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(key)).slice(0, 200) : [];
      setPendingIntent(keys.length ? { scope: viewerScope, providerId: selectedProviderId, keys } : undefined);
    } catch { setPendingStorageWarning(true); setPendingIntent(undefined); }
  }, [pendingDraftKey]);

  function rememberPending(providerId: string, keys: string[]) {
    setPendingIntent(keys.length ? { scope: viewerScope, providerId, keys } : undefined);
    const key = `dashboard:bulk-pending:${viewerId || "fixture"}:${providerId}:${editableGuilds.map(guild => guild.guildId).sort().join(",")}`;
    try { if (keys.length) window.localStorage.setItem(key, JSON.stringify(keys)); else window.localStorage.removeItem(key); }
    catch { setPendingStorageWarning(true); }
  }

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
        if (active) { setProviderSettings(settings.filter((setting) => setting.kind !== "targets")); setSettingsProviderId(selectedProviderId); setSettingsGuildId(baselineGuild.guildId); }
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
  }, [baselineGuild?.guildId, selectedProviderId, refreshVersion]);

  async function applyPreset(label: string, changes: Record<string, unknown>) {
    if (!editableGuilds.length) return;
    if (!confirm(t("multiBulk.confirm", { label, count: editableGuilds.length }))) return;
    const results = await batch.run({ kind: "preset", label, changes: changes as Record<string, SettingValue>, targets: editableGuilds });
    if (results.some(result => result.status === "saved")) setRefreshVersion(version => version + 1);
  }

  async function applyProviderChanges(changes: Record<string, SettingValue>) {
    if (!selectedProviderId || !editableGuilds.length || !selectedProvider) return;
    const retry = batch.plan?.kind === "provider" && batch.plan.providerId === selectedProviderId && deepEqual(batch.plan.changes, changes) && batch.results.some(result => result.status === "failed");
    const count = retry ? batch.results.filter(result => result.status === "failed").length : editableGuilds.length;
    if (!confirm(t("multiBulk.detailConfirm", { provider: selectedProvider.label, count }))) {
      return { cancelled: true };
    }
    const plan = retry ? batch.plan! : { kind: "provider" as const, label: selectedProvider.label, providerId: selectedProviderId, changes: structuredClone(changes), targets: editableGuilds };
    const results = await batch.run(plan, retry);
    if (!results.length) return { cancelled: true };
    const failed = results.filter(result => result.status === "failed").length;
    const warnings = [...new Set(results.flatMap(result => result.warnings))];
    rememberPending(selectedProviderId, failed ? Object.keys(plan.changes) : []);
    if (!failed) setRefreshVersion(version => version + 1);
    return {
      complete: failed === 0,
      warnings: [failed ? locale === "ja" ? `${results.length - failed}サーバーに保存しました。${failed}サーバーは再試行が必要です。` : `Saved to ${results.length - failed} servers. Retry ${failed} failed servers.` : t("multiBulk.detailDone", { count: results.length }), ...warnings],
    };
  }

  async function retryFailed() {
    if (!batch.plan || batch.busy) return;
    const results = await batch.run(batch.plan, true);
    if (!results.length) return;
    const complete = results.every(result => result.status === "saved");
    if (batch.plan.kind === "provider" && complete) { rememberPending(batch.plan.providerId!, []); setExternalSaved({ sequence: ++savedSequence.current, changes: batch.plan.changes, warnings: [t("multiBulk.detailDone", { count: results.length }), ...new Set(results.flatMap(result => result.warnings))], scopeKey: viewerScope, providerId: batch.plan.providerId! }); }
    if (complete || batch.plan.kind === "preset" && results.some(result => result.status === "saved")) setRefreshVersion(version => version + 1);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">{t("multiBulk.selectedTitle")}<Badge tone="muted">{guilds.length}</Badge></CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {guilds.map((guild) => (
            <Badge key={guild.guildId} tone={guild.canManageGuild ? "default" : "warning"}>
              {!guild.canManageGuild ? <LockKeyhole size={12} className="mr-1" aria-hidden="true" /> : null}
              {guild.name}
            </Badge>
          ))}
        </CardContent>
      </Card>

      {batch.plan && <SettingsSaveResults label={batch.plan.label} results={batch.results} busy={batch.busy} locale={locale} onRetry={() => void retryFailed()} retryAllowed={batch.plan.kind === "preset" || batch.plan.providerId === selectedProviderId && deepEqual(batch.plan.changes, draftChanges)} />}
      {pendingStorageWarning && <p role="status" className="flex items-start gap-2 text-sm text-muted-foreground"><Info size={16} className="shrink-0" aria-hidden="true" />{locale === "ja" ? "未完了の保存をブラウザに記録できません。この画面で保存を完了してください。" : "Unfinished saves cannot be recorded in this browser. Complete the save on this page."}</p>}

      {blocked.length ? (
        <Card>
          <CardContent className="flex items-start gap-2 pt-4 text-sm text-muted-foreground">
            <LockKeyhole size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
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
          <p className="flex items-start gap-2 text-sm text-muted-foreground"><Server size={15} className="mt-0.5 shrink-0" aria-hidden="true" />{t("multiBulk.note")}</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {presets.map((preset) => (
            <Button className="w-full sm:w-auto" key={preset.labelKey} variant="outline" disabled={!editableGuilds.length || saving !== null} onClick={() => applyPreset(t(preset.labelKey), preset.changes)}>
              {saving === t(preset.labelKey) ? t("settingsCross.saving") : locale === "ja" ? `${t(preset.labelKey)}を適用` : `Apply ${t(preset.labelKey)}`}
            </Button>
          ))}
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
                    aria-label={t("multiBulk.provider")}
                    className="h-10 w-full min-w-0 rounded-md border bg-card px-3 text-sm"
                    value={selectedProviderId}
                    disabled={batch.busy}
                    onChange={(event) => { setSelectedProviderId(event.target.value); setExternalSaved(undefined); }}
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
              <p className="flex items-start gap-2 text-xs text-muted-foreground"><Info size={14} className="shrink-0" aria-hidden="true" />{t("multiBulk.detailTargetsNote")}</p>
              {providerError ? <div className="rounded-md border bg-card p-3 text-sm text-destructive">{providerError}</div> : null}
              {loadingProvider ? <div className="rounded-md border bg-card p-3 text-sm text-muted-foreground">{t("shell.guildSwitcher.loading")}</div> : null}
              {selectedProvider && settingsProviderId === selectedProviderId && settingsGuildId === baselineGuild.guildId && providerSettings.length ? (
                <ProviderSettingsForm
                  key={`${baselineGuild.guildId}:${selectedProviderId}`}
                  guildId={baselineGuild.guildId}
                  providerId={selectedProviderId}
                  providerLabel={selectedProvider.label}
                  scopeLabel={locale === "ja" ? `${editableGuilds.length}サーバーに適用` : `Applies to ${editableGuilds.length} servers`}
                  canEdit={editableGuilds.length > 0}
                  settings={providerSettings}
                  locale={locale}
                  draftKeyOverride={`dashboard:bulk-draft:${viewerId ? `${viewerId}:` : ""}${selectedProviderId}:${editableGuilds.map((guild) => guild.guildId).sort().join(",")}`}
                  onSaveChanges={applyProviderChanges}
                  onChangesChange={receiveChanges}
                  externalSaved={externalSaved?.scopeKey === `${viewerId || "fixture"}:${scopeKey}` && externalSaved.providerId === selectedProviderId ? externalSaved : undefined}
                  viewerId={viewerId}
                  externalSaving={batch.busy}
                  requiredSaveKeys={pendingIntent?.scope === viewerScope && pendingIntent.providerId === selectedProviderId ? pendingIntent.keys : []}
                  showResetProvider={false}
                />
              ) : null}
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><LockKeyhole size={15} aria-hidden="true" />{t("multiBulk.noEditable")}</div>
          )}
        </div>
      </section>
    </div>
  );
}
