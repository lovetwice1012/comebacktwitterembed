"use client";

import { ArrowRightLeft, Search, Server, X } from "lucide-react";
import { useMemo, useState } from "react";
import { pushGuildSelection } from "@/components/dashboard/guild-options";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createTranslator, type DashboardLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Guild = {
  guildId: string;
  name: string;
  iconUrl: string | null;
  canEdit: boolean;
  canManageGuild: boolean;
  permissions: {
    administrator: boolean;
    manageGuild: boolean;
    manageChannels: boolean;
  };
  providerSummary: {
    enabled: number;
    disabled: number;
    total: number;
  };
};

export function GuildList({ guilds, locale }: { guilds: Guild[]; locale: DashboardLocale }) {
  const t = createTranslator(locale);
  const [query, setQuery] = useState("");
  const [sourceGuildId, setSourceGuildId] = useState("");
  const [copyMode, setCopyMode] = useState(false);
  const [targetGuildIds, setTargetGuildIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return guilds;
    return guilds.filter((guild) => guild.name.toLowerCase().includes(q) || guild.guildId.includes(q));
  }, [guilds, query]);
  const sourceGuild = guilds.find((guild) => guild.guildId === sourceGuildId);

  function toggleSource(guildId: string, checked: boolean) {
    setMessage(null);
    setSourceGuildId(checked ? guildId : "");
    setCopyMode(false);
    setTargetGuildIds([]);
  }

  function toggleTarget(guildId: string, checked: boolean) {
    setMessage(null);
    setTargetGuildIds((current) => {
      if (checked) return [...new Set([...current, guildId])];
      return current.filter((id) => id !== guildId);
    });
  }

  function cancelCopyMode() {
    setCopyMode(false);
    setSourceGuildId("");
    setTargetGuildIds([]);
    setMessage(null);
  }

  function handleCardAction(guild: Guild, disabled: boolean, checked: boolean) {
    if (busy) return;
    if (copyMode) {
      if (disabled) return;
      toggleTarget(guild.guildId, !checked);
      return;
    }
    pushGuildSelection([guild.guildId]);
  }

  async function copySettings() {
    if (!sourceGuildId) {
      setMessage(t("guildList.copyNoSource"));
      return;
    }
    if (!targetGuildIds.length) {
      setMessage(t("guildList.copyNoTargets"));
      return;
    }
    if (!confirm(t("guildList.copyConfirm", { source: sourceGuild?.name || sourceGuildId, count: targetGuildIds.length }))) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/guilds/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceGuildId, targetGuildIds }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || t("sync.failed"));
      setMessage(t("guildList.copyDone", { count: json.targetCount || targetGuildIds.length }));
      setCopyMode(false);
      setSourceGuildId("");
      setTargetGuildIds([]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("sync.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 basis-full sm:min-w-64 sm:basis-auto">
          <Search className="pointer-events-none absolute left-3 top-3 text-muted-foreground" size={16} />
          <Input className="pl-9" placeholder={t("guildList.searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        {!copyMode ? (
          <Button className="w-full sm:w-auto" variant="outline" disabled={!sourceGuildId} onClick={() => setCopyMode(true)}>
            <ArrowRightLeft size={16} />
            {t("guildList.copySettings")}
          </Button>
        ) : (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Badge tone="default">{t("guildList.copySource", { source: sourceGuild?.name || sourceGuildId })}</Badge>
            <Badge tone={targetGuildIds.length ? "success" : "muted"}>{t("guildList.copyTargets", { count: targetGuildIds.length })}</Badge>
            <Button className="flex-1 sm:flex-none" onClick={copySettings} disabled={busy || !targetGuildIds.length}>
              <ArrowRightLeft size={16} />
              {busy ? t("sync.busy") : t("guildList.copyRun")}
            </Button>
            <Button className="flex-1 sm:flex-none" variant="ghost" onClick={cancelCopyMode} disabled={busy}>
              <X size={16} />
              {t("guildList.copyCancel")}
            </Button>
          </div>
        )}
      </div>
      {message ? <div className="rounded-md border bg-card p-3 text-sm text-muted-foreground">{message}</div> : null}
      {copyMode ? <div className="rounded-md border bg-muted p-3 text-sm text-muted-foreground">{t("guildList.copyModeHelp")}</div> : null}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((guild) => {
          const isSource = guild.guildId === sourceGuildId;
          const checked = copyMode ? targetGuildIds.includes(guild.guildId) : isSource;
          const disabled = copyMode && (isSource || !guild.canManageGuild);
          return (
            <Card
              key={guild.guildId}
              className={cn(
                "relative h-full transition hover:border-primary hover:shadow-soft",
                copyMode && disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer",
              )}
              role="button"
              tabIndex={0}
              onClick={() => handleCardAction(guild, disabled, checked)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                handleCardAction(guild, disabled, checked);
              }}
            >
              <div className="absolute left-0 top-0 z-10 flex h-11 w-11 items-start justify-start p-3" onClick={(event) => event.stopPropagation()}>
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={checked}
                  disabled={disabled || busy}
                  aria-label={copyMode ? t("guildList.copyTargetCheckbox") : t("guildList.copySourceCheckbox")}
                  onChange={(event) => {
                    if (copyMode) toggleTarget(guild.guildId, event.target.checked);
                    else toggleSource(guild.guildId, event.target.checked);
                  }}
                />
              </div>
              <CardHeader className="flex flex-row items-center gap-3 space-y-0 pl-10">
                {guild.iconUrl ? (
                  <img src={guild.iconUrl} alt="" className="h-10 w-10 rounded-md" />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
                    <Server size={18} />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <CardTitle className="truncate">{guild.name}</CardTitle>
                  <CardDescription className="truncate">{guild.guildId}</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Badge tone={guild.canEdit ? "success" : "muted"}>{guild.canEdit ? t("guildList.canEdit") : t("guildList.viewOnly")}</Badge>
                  {copyMode && isSource ? <Badge tone="default">{t("guildList.copySourceBadge")}</Badge> : null}
                  {copyMode && !isSource && !guild.canManageGuild ? <Badge tone="warning">{t("guildList.copyTargetLocked")}</Badge> : null}
                  {guild.permissions.administrator ? <Badge tone="danger">Administrator</Badge> : null}
                  {guild.permissions.manageGuild ? <Badge tone="default">Manage Server</Badge> : null}
                  {guild.permissions.manageChannels ? <Badge tone="default">Manage Channels</Badge> : null}
                </div>
                {guild.providerSummary.total > 0 ? (
                  <div className="text-sm text-muted-foreground">
                    {t("guildList.providerSummary", { enabled: guild.providerSummary.enabled, total: guild.providerSummary.total })}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
