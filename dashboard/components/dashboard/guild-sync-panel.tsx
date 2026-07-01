"use client";

import { ArrowRightLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createTranslator, type DashboardLocale } from "@/lib/i18n";

type Guild = {
  guildId: string;
  name: string;
  canManageGuild: boolean;
};

function firstDifferent(guilds: Guild[], sourceGuildId: string) {
  return guilds.find((guild) => guild.canManageGuild && guild.guildId !== sourceGuildId)?.guildId || "";
}

export function GuildSyncPanel({ guilds, locale }: { guilds: Guild[]; locale: DashboardLocale }) {
  const t = createTranslator(locale);
  const manageableTargets = useMemo(() => guilds.filter((guild) => guild.canManageGuild), [guilds]);
  const [sourceGuildId, setSourceGuildId] = useState(guilds[0]?.guildId || "");
  const [targetGuildId, setTargetGuildId] = useState(firstDifferent(guilds, guilds[0]?.guildId || ""));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function sync() {
    if (!sourceGuildId || !targetGuildId || sourceGuildId === targetGuildId) {
      setMessage(t("sync.sameGuild"));
      return;
    }
    if (!confirm(t("sync.confirm"))) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/guilds/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceGuildId, targetGuildId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("sync.failed"));
      setMessage(t("sync.done", { providers: json.providerCount, settings: json.copied, skipped: json.skippedTargets }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("sync.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArrowRightLeft size={18} />
          {t("sync.title")}
        </CardTitle>
        <CardDescription>{t("sync.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <label className="space-y-1 text-sm">
            <span className="font-medium">{t("sync.source")}</span>
            <select
              className="h-10 w-full rounded-md border bg-card px-3 text-sm"
              value={sourceGuildId}
              onChange={(event) => {
                const next = event.target.value;
                setSourceGuildId(next);
                if (!targetGuildId || targetGuildId === next) setTargetGuildId(firstDifferent(guilds, next));
              }}
            >
              {guilds.map((guild) => (
                <option key={guild.guildId} value={guild.guildId}>{guild.name}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">{t("sync.target")}</span>
            <select
              className="h-10 w-full rounded-md border bg-card px-3 text-sm"
              value={targetGuildId}
              onChange={(event) => setTargetGuildId(event.target.value)}
            >
              <option value="">{t("sync.targetPlaceholder")}</option>
              {manageableTargets.map((guild) => (
                <option key={guild.guildId} value={guild.guildId}>{guild.name}</option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <Button className="w-full md:w-auto" onClick={sync} disabled={busy || !sourceGuildId || !targetGuildId || sourceGuildId === targetGuildId}>
              {busy ? t("sync.busy") : t("sync.submit")}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("sync.note")}</p>
        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
      </CardContent>
    </Card>
  );
}
