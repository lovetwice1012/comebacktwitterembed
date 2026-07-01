"use client";

import { Search, Server } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Guild = {
  guildId: string;
  name: string;
  iconUrl: string | null;
  canEdit: boolean;
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

export function GuildList({ guilds }: { guilds: Guild[] }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return guilds;
    return guilds.filter((guild) => guild.name.toLowerCase().includes(q) || guild.guildId.includes(q));
  }, [guilds, query]);

  return (
    <div className="space-y-4">
      <div className="relative max-w-xl">
        <Search className="pointer-events-none absolute left-3 top-3 text-muted-foreground" size={16} />
        <Input className="pl-9" placeholder="サーバー名またはguild IDで検索" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((guild) => (
          <Link key={guild.guildId} href={`/dashboard/${guild.guildId}`} className="block">
            <Card className="h-full transition hover:border-primary hover:shadow-soft">
              <CardHeader className="flex flex-row items-center gap-3 space-y-0">
                {guild.iconUrl ? (
                  <img src={guild.iconUrl} alt="" className="h-10 w-10 rounded-md" />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
                    <Server size={18} />
                  </div>
                )}
                <div className="min-w-0">
                  <CardTitle className="truncate">{guild.name}</CardTitle>
                  <CardDescription className="truncate">{guild.guildId}</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Badge tone={guild.canEdit ? "success" : "muted"}>{guild.canEdit ? "設定変更可能" : "閲覧のみ"}</Badge>
                  {guild.permissions.administrator ? <Badge tone="danger">Administrator</Badge> : null}
                  {guild.permissions.manageGuild ? <Badge tone="default">Manage Server</Badge> : null}
                  {guild.permissions.manageChannels ? <Badge tone="default">Manage Channels</Badge> : null}
                </div>
                <div className="text-sm text-muted-foreground">
                  Provider: {guild.providerSummary.enabled} enabled / {guild.providerSummary.total} total
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
