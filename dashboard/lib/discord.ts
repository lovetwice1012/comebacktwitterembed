import "server-only";

import { cache } from "react";
import { getBotToken } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { canEditSettings, canManageGuildSettings, canViewSettings, parsePermissions } from "@/lib/permissions";
import { getProviderSummary } from "@/lib/settings-db";
import type { DashboardSession, GuildAccess } from "@/lib/types";

type DiscordGuild = {
  id: string;
  name: string;
  icon: string | null;
  owner?: boolean;
  permissions?: string;
};

type DiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
};

async function discordFetch<T>(path: string, token: string, authType: "Bearer" | "Bot") {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    headers: {
      Authorization: `${authType} ${token}`,
      "User-Agent": "comebacktwitterembed-dashboard",
    },
    next: { revalidate: 30 },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord API ${path} returned ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function fetchDiscordMe(accessToken: string) {
  const user = await discordFetch<DiscordUser>("/users/@me", accessToken, "Bearer");
  return {
    id: user.id,
    username: user.username,
    globalName: user.global_name,
    avatarUrl: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : null,
  };
}

export const fetchUserGuilds = cache(async (accessToken: string) => {
  return discordFetch<DiscordGuild[]>("/users/@me/guilds", accessToken, "Bearer");
});

export const fetchBotGuildIds = cache(async () => {
  const token = getBotToken();
  if (!token) return null;
  const guilds = await discordFetch<DiscordGuild[]>("/users/@me/guilds", token, "Bot");
  return new Set(guilds.map((guild) => guild.id));
});

async function fallbackBotInstalledGuildIds() {
  const rows = await prisma.$queryRaw<Array<{ guild_id: string }>>`SELECT guild_id FROM guilds`;
  return new Set(rows.map((row) => row.guild_id));
}

export function guildIconUrl(guild: Pick<DiscordGuild, "id" | "icon">) {
  return guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128` : null;
}

export async function listVisibleGuilds(session: DashboardSession) {
  const [userGuilds, botGuilds] = await Promise.all([
    fetchUserGuilds(session.accessToken),
    fetchBotGuildIds().catch(() => null),
  ]);
  const installed = botGuilds || (await fallbackBotInstalledGuildIds().catch(() => new Set<string>()));

  const out = await Promise.all(
    userGuilds.map(async (guild) => {
      const permissions = parsePermissions(guild.owner ? BigInt("9223372036854775807") : guild.permissions || "0");
      const botInstalled = installed.has(guild.id);
      const canView = botInstalled && canViewSettings(permissions);
      const canEdit = botInstalled && canEditSettings(permissions);
      const canManageGuild = botInstalled && canManageGuildSettings(permissions);
      const providerSummary = canView ? await getProviderSummary(guild.id).catch(() => ({ enabled: 0, disabled: 0, total: 0 })) : { enabled: 0, disabled: 0, total: 0 };
      return {
        guildId: guild.id,
        name: guild.name,
        iconUrl: guildIconUrl(guild),
        botInstalled,
        canView,
        canEdit,
        canManageGuild,
        permissions,
        providerSummary,
      };
    }),
  );

  return out
    .filter((guild) => guild.botInstalled && guild.canView)
    .sort((a, b) => Number(b.canEdit) - Number(a.canEdit) || a.name.localeCompare(b.name));
}

export async function getGuildAccess(session: DashboardSession, guildId: string): Promise<GuildAccess | null> {
  const guilds = await listVisibleGuilds(session);
  return guilds.find((guild) => guild.guildId === guildId) || null;
}
