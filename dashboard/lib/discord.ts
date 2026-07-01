import "server-only";

import { cache } from "react";
import { getBotToken, getDashboardFlag, getDashboardNumber } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { canEditSettings, canManageGuildSettings, canViewSettings, parsePermissions } from "@/lib/permissions";
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

const DISCORD_API_TIMEOUT_MS = getDashboardNumber("discordApiTimeoutMs", "DISCORD_API_TIMEOUT_MS", 8000);
const GUILD_CACHE_TTL_MS = getDashboardNumber("guildCacheTtlMs", "DASHBOARD_GUILD_CACHE_TTL_MS", 60_000);
const USE_BOT_GUILD_API = getDashboardFlag("useBotGuildApi", "DASHBOARD_USE_BOT_GUILD_API");
const LOAD_GUILD_PROVIDER_SUMMARY = getDashboardFlag("loadGuildProviderSummary", "DASHBOARD_LOAD_GUILD_PROVIDER_SUMMARY");

type CacheEntry<T> = {
  expiresAt: number;
  promise: Promise<T>;
};

const userGuildCache = new Map<string, CacheEntry<DiscordGuild[]>>();
let botGuildDiscordCache: CacheEntry<Set<string> | null> | null = null;
let botGuildDatabaseCache: CacheEntry<Set<string>> | null = null;

function cached<T>(entry: CacheEntry<T> | null, load: () => Promise<T>): CacheEntry<T> {
  if (entry && entry.expiresAt > Date.now()) return entry;
  return {
    expiresAt: Date.now() + GUILD_CACHE_TTL_MS,
    promise: load(),
  };
}

function cachedByKey<T>(map: Map<string, CacheEntry<T>>, key: string, load: () => Promise<T>) {
  const current = map.get(key) || null;
  const next = cached(current, load);
  if (next !== current) map.set(key, next);
  return next.promise;
}

async function discordFetch<T>(path: string, token: string, authType: "Bearer" | "Bot") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCORD_API_TIMEOUT_MS);
  try {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
      headers: {
        Authorization: `${authType} ${token}`,
        "User-Agent": "comebacktwitterembed-dashboard",
      },
      next: { revalidate: 30 },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Discord API ${path} returned ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Discord API ${path} timed out after ${DISCORD_API_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
  return cachedByKey(userGuildCache, accessToken, () => discordFetch<DiscordGuild[]>("/users/@me/guilds", accessToken, "Bearer"));
});

const fetchBotGuildIdsFromDiscord = cache(async () => {
  const token = getBotToken();
  if (!token) return null;
  botGuildDiscordCache = cached(botGuildDiscordCache, async () => {
    const guilds = await discordFetch<DiscordGuild[]>("/users/@me/guilds", token, "Bot");
    return new Set(guilds.map((guild) => guild.id));
  });
  return botGuildDiscordCache.promise;
});

const fetchBotGuildIdsFromDatabase = cache(async () => {
  botGuildDatabaseCache = cached(botGuildDatabaseCache, async () => {
    const rows = await prisma.$queryRaw<Array<{ guild_id: string }>>`SELECT guild_id FROM guilds`;
    return new Set(rows.map((row) => row.guild_id));
  });
  return botGuildDatabaseCache.promise;
});

export const fetchBotGuildIds = cache(async () => {
  const dbGuildIds = await fetchBotGuildIdsFromDatabase().catch(() => new Set<string>());
  if (!USE_BOT_GUILD_API) return dbGuildIds;
  return await fetchBotGuildIdsFromDiscord().catch(() => dbGuildIds) || dbGuildIds;
});

async function providerSummaryForGuild(guildId: string) {
  if (!LOAD_GUILD_PROVIDER_SUMMARY) return { enabled: 0, disabled: 0, total: 0 };
  const { getProviderSummary } = await import("@/lib/settings-db");
  return getProviderSummary(guildId).catch(() => ({ enabled: 0, disabled: 0, total: 0 }));
}

export function guildIconUrl(guild: Pick<DiscordGuild, "id" | "icon">) {
  return guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128` : null;
}

export async function listVisibleGuilds(session: DashboardSession) {
  const [userGuilds, installed] = await Promise.all([
    fetchUserGuilds(session.accessToken),
    fetchBotGuildIds(),
  ]);

  const out = await Promise.all(
    userGuilds.map(async (guild) => {
      const permissions = parsePermissions(guild.owner ? BigInt("9223372036854775807") : guild.permissions || "0");
      const botInstalled = installed.has(guild.id);
      const canView = botInstalled && canViewSettings(permissions);
      const canEdit = botInstalled && canEditSettings(permissions);
      const canManageGuild = botInstalled && canManageGuildSettings(permissions);
      const providerSummary = canView ? await providerSummaryForGuild(guild.id) : { enabled: 0, disabled: 0, total: 0 };
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
  const [userGuilds, installed] = await Promise.all([
    fetchUserGuilds(session.accessToken),
    fetchBotGuildIds(),
  ]);
  const guild = userGuilds.find((item) => item.id === guildId);
  if (!guild || !installed.has(guild.id)) return null;

  const permissions = parsePermissions(guild.owner ? BigInt("9223372036854775807") : guild.permissions || "0");
  if (!canViewSettings(permissions)) return null;

  return {
    guildId: guild.id,
    name: guild.name,
    iconUrl: guildIconUrl(guild),
    botInstalled: true,
    canView: true,
    canEdit: canEditSettings(permissions),
    canManageGuild: canManageGuildSettings(permissions),
    permissions,
  };
}
