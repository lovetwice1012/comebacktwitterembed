import "server-only";

import { cache } from "react";
import { getBotToken, getDashboardFlag, getDashboardNumber } from "@/lib/env";
import {
  delegatedAccessEnabled,
  delegatedAccessLevelForTargets,
  isDiscordSnowflake,
  listDelegatedAccess,
  type DelegatedAccessLevel,
  type DelegatedAccessTargetType,
} from "@/lib/delegated-access";
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

type DiscordGuildMember = {
  user?: DiscordUser;
  nick?: string | null;
  avatar?: string | null;
  roles: string[];
};

type DiscordRole = {
  id: string;
  name: string;
  color: number;
  managed: boolean;
  position: number;
};

export type GuildAccessMember = {
  id: string;
  username: string;
  nickname: string | null;
  avatarUrl: string | null;
};

export type GuildAccessRole = {
  id: string;
  name: string;
  color: string | null;
  managed: boolean;
  position: number;
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

async function discordFetch<T>(
  path: string,
  token: string,
  authType: "Bearer" | "Bot",
  cacheMode: "default" | "no-store" = "default",
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCORD_API_TIMEOUT_MS);
  try {
    const cacheOptions = cacheMode === "no-store" ? { cache: "no-store" as const } : { next: { revalidate: 30 } };
    const res = await fetch(`https://discord.com/api/v10${path}`, {
      headers: {
        Authorization: `${authType} ${token}`,
        "User-Agent": "comebacktwitterembed-dashboard",
      },
      ...cacheOptions,
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

function memberAvatarUrl(guildId: string, member: DiscordGuildMember) {
  const user = member.user;
  if (!user) return null;
  if (member.avatar) return `https://cdn.discordapp.com/guilds/${guildId}/users/${user.id}/avatars/${member.avatar}.png?size=128`;
  return user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : null;
}

async function fetchGuildMemberRoleIds(guildId: string, userId: string): Promise<string[] | null> {
  if (!delegatedAccessEnabled() || !isDiscordSnowflake(guildId) || !isDiscordSnowflake(userId)) return null;
  const token = getBotToken();
  if (!token) return null;
  try {
    const member = await discordFetch<DiscordGuildMember>(`/guilds/${guildId}/members/${userId}`, token, "Bot", "no-store");
    return Array.isArray(member.roles) ? member.roles.filter(isDiscordSnowflake) : null;
  } catch {
    // A failed membership lookup must never turn into delegated access.
    return null;
  }
}

async function delegatedAccessForGuild(guildId: string, userId: string): Promise<DelegatedAccessLevel | null> {
  if (!delegatedAccessEnabled()) return null;
  const grants = (await listDelegatedAccess(guildId)).filter(
    (grant) => grant.targetType !== "role" || grant.targetId !== guildId,
  );
  if (grants.length === 0) return null;
  const roleIds = await fetchGuildMemberRoleIds(guildId, userId);
  // Confirm that the Discord account is still a current member before honoring
  // either a direct-user grant or a role grant. This fails closed on API errors.
  if (!roleIds) return null;
  return delegatedAccessLevelForTargets(grants, userId, roleIds);
}

export async function fetchGuildAccessDirectory(guildId: string, query: string) {
  if (!delegatedAccessEnabled() || !isDiscordSnowflake(guildId)) {
    return { members: [] as GuildAccessMember[], roles: [] as GuildAccessRole[], directoryError: null };
  }

  const token = getBotToken();
  if (!token) {
    return { members: [] as GuildAccessMember[], roles: [] as GuildAccessRole[], directoryError: "Discord bot token is unavailable." };
  }

  const trimmedQuery = query.trim().slice(0, 100);
  const [membersResult, rolesResult] = await Promise.allSettled([
    trimmedQuery
      ? discordFetch<DiscordGuildMember[]>(`/guilds/${guildId}/members/search?query=${encodeURIComponent(trimmedQuery)}&limit=25`, token, "Bot", "no-store")
      : Promise.resolve([] as DiscordGuildMember[]),
    discordFetch<DiscordRole[]>(`/guilds/${guildId}/roles`, token, "Bot", "no-store"),
  ]);

  const members = membersResult.status === "fulfilled"
    ? membersResult.value
      .filter((member) => member.user && isDiscordSnowflake(member.user.id))
      .map((member) => ({
        id: member.user!.id,
        username: member.user!.username,
        nickname: member.nick || null,
        avatarUrl: memberAvatarUrl(guildId, member),
      }))
    : [];
  const roles = rolesResult.status === "fulfilled"
    ? rolesResult.value
      .filter((role) => isDiscordSnowflake(role.id) && role.id !== guildId)
      .sort((a, b) => b.position - a.position)
      .map((role) => ({
        id: role.id,
        name: role.name,
        color: role.color ? `#${role.color.toString(16).padStart(6, "0")}` : null,
        managed: role.managed,
        position: role.position,
      }))
    : [];

  return {
    members,
    roles,
    directoryError: membersResult.status === "rejected" || rolesResult.status === "rejected"
      ? "Discord member or role data is temporarily unavailable."
      : null,
  };
}

export async function validateGuildAccessTargets(
  guildId: string,
  targetType: DelegatedAccessTargetType,
  targetIds: string[],
) {
  if (!delegatedAccessEnabled() || !isDiscordSnowflake(guildId) || targetIds.some((id) => !isDiscordSnowflake(id))) {
    return false;
  }
  const token = getBotToken();
  if (!token) return false;

  if (targetType === "role") {
    try {
      const roles = await discordFetch<DiscordRole[]>(`/guilds/${guildId}/roles`, token, "Bot", "no-store");
      const roleIds = new Set(roles.map((role) => role.id));
      return targetIds.every((id) => id !== guildId && roleIds.has(id));
    } catch {
      return false;
    }
  }

  // Validate users as current guild members. Keep the request fan-out bounded
  // so a bulk action cannot exhaust the Discord API rate limit.
  let next = 0;
  let valid = true;
  const worker = async () => {
    while (valid) {
      const index = next;
      next += 1;
      if (index >= targetIds.length) return;
      try {
        await discordFetch<DiscordGuildMember>(`/guilds/${guildId}/members/${targetIds[index]}`, token, "Bot", "no-store");
      } catch {
        valid = false;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, targetIds.length) }, worker));
  return valid;
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
      const nativeCanView = canViewSettings(permissions);
      const delegatedAccess = botInstalled && !nativeCanView ? await delegatedAccessForGuild(guild.id, session.user.id) : null;
      const canView = botInstalled && (nativeCanView || delegatedAccess !== null);
      const canEdit = botInstalled && (canEditSettings(permissions) || delegatedAccess === "edit");
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

export async function listSwitcherGuilds(session: DashboardSession) {
  const [userGuilds, installed] = await Promise.all([
    fetchUserGuilds(session.accessToken),
    fetchBotGuildIds(),
  ]);

  const out = await Promise.all(
    userGuilds.map(async (guild) => {
      const permissions = parsePermissions(guild.owner ? BigInt("9223372036854775807") : guild.permissions || "0");
      const botInstalled = installed.has(guild.id);
      const nativeCanView = canViewSettings(permissions);
      const delegatedAccess = botInstalled && !nativeCanView ? await delegatedAccessForGuild(guild.id, session.user.id) : null;
      const canView = botInstalled && (nativeCanView || delegatedAccess !== null);
      return {
        guildId: guild.id,
        name: guild.name,
        iconUrl: guildIconUrl(guild),
        canView,
        canEdit: botInstalled && (canEditSettings(permissions) || delegatedAccess === "edit"),
        canManageGuild: botInstalled && canManageGuildSettings(permissions),
      };
    }),
  );

  return out
    .filter((guild) => guild.canView)
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
  const nativeCanView = canViewSettings(permissions);
  const delegatedAccess = !nativeCanView ? await delegatedAccessForGuild(guild.id, session.user.id) : null;
  if (!nativeCanView && !delegatedAccess) return null;

  return {
    guildId: guild.id,
    name: guild.name,
    iconUrl: guildIconUrl(guild),
    botInstalled: true,
    canView: true,
    canEdit: canEditSettings(permissions) || delegatedAccess === "edit",
    canManageGuild: canManageGuildSettings(permissions),
    permissions,
  };
}
