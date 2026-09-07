import "server-only";

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  getDashboardFlag,
  getDelegatedAccessRolloutDurationHours,
  getDelegatedAccessRolloutStartAt,
} from "@/lib/env";

export type DelegatedAccessLevel = "view" | "edit";
export type DelegatedAccessTargetType = "user" | "role";
export type DelegatedAccessGrant = {
  guildId: string;
  targetType: DelegatedAccessTargetType;
  targetId: string;
  accessLevel: DelegatedAccessLevel;
  grantedByUserId: string;
};

const TABLE = "dashboard_delegated_access_grants";
const SNOWFLAKE = /^\d{16,24}$/;
const INITIAL_ROLLOUT_GUILD_ID = "1132814274734067772";
const INITIAL_ROLLOUT_FRACTION = 1 / 14;
let ensureTablePromise: Promise<void> | null = null;

export function delegatedAccessEnabled() {
  return getDashboardFlag("delegatedAccessEnabled", "DASHBOARD_DELEGATED_ACCESS_ENABLED");
}

export function delegatedAccessRolloutBucket(guildId: string) {
  const digest = createHash("sha256").update(guildId).digest("hex").slice(0, 12);
  return Number.parseInt(digest, 16) / 0x1000000000000;
}

export function delegatedAccessEnabledForGuild(guildId: string, nowMs = Date.now()) {
  if (!delegatedAccessEnabled()) return false;
  const startAt = getDelegatedAccessRolloutStartAt();
  if (!startAt) return true;
  const startMs = Date.parse(startAt);
  const durationHours = getDelegatedAccessRolloutDurationHours();
  if (!Number.isFinite(startMs) || !durationHours) return false;
  if (nowMs < startMs) return false;
  if (guildId === INITIAL_ROLLOUT_GUILD_ID) return true;
  const elapsed = Math.max(0, Math.min(1, (nowMs - startMs) / (durationHours * 60 * 60 * 1000)));
  const progress = INITIAL_ROLLOUT_FRACTION + elapsed * (1 - INITIAL_ROLLOUT_FRACTION);
  return delegatedAccessRolloutBucket(guildId) <= progress;
}

export function isDiscordSnowflake(value: string) {
  return SNOWFLAKE.test(value);
}

export async function ensureDelegatedAccessTable() {
  ensureTablePromise ??= prisma
    .$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${TABLE} (grant_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, guild_id VARCHAR(32) NOT NULL, target_type ENUM('user','role') NOT NULL, target_id VARCHAR(32) NOT NULL, access_level ENUM('view','edit') NOT NULL, granted_by_user_id VARCHAR(32) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY uniq_dashboard_delegated_access_target (guild_id,target_type,target_id), INDEX idx_dashboard_delegated_access_guild (guild_id)) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    .then(() => undefined)
    .catch((error) => {
      ensureTablePromise = null;
      throw error;
    });
  await ensureTablePromise;
}

export async function listDelegatedAccess(guildId: string): Promise<DelegatedAccessGrant[]> {
  if (!isDiscordSnowflake(guildId)) return [];
  await ensureDelegatedAccessTable();
  const rows = await prisma.$queryRawUnsafe<Array<{
    guild_id: string;
    target_type: DelegatedAccessTargetType;
    target_id: string;
    access_level: DelegatedAccessLevel;
    granted_by_user_id: string;
  }>>(`SELECT guild_id, target_type, target_id, access_level, granted_by_user_id FROM ${TABLE} WHERE guild_id = ? ORDER BY target_type, target_id`, guildId);
  return rows.map((row) => ({
    guildId: row.guild_id,
    targetType: row.target_type,
    targetId: row.target_id,
    accessLevel: row.access_level,
    grantedByUserId: row.granted_by_user_id,
  }));
}

export function delegatedAccessLevelForTargets(
  grants: DelegatedAccessGrant[],
  userId: string,
  roleIds: string[],
): DelegatedAccessLevel | null {
  const roles = new Set(roleIds);
  let hasView = false;
  for (const grant of grants) {
    const matchesUser = grant.targetType === "user" && grant.targetId === userId;
    const matchesRole = grant.targetType === "role" && roles.has(grant.targetId);
    if (!matchesUser && !matchesRole) continue;
    if (grant.accessLevel === "edit") return "edit";
    hasView = true;
  }
  return hasView ? "view" : null;
}

export async function replaceDelegatedAccess(input: {
  guildId: string;
  targetType: DelegatedAccessTargetType;
  targetIds: string[];
  accessLevel?: DelegatedAccessLevel;
  actorUserId: string;
}) {
  if (!delegatedAccessEnabledForGuild(input.guildId)) throw new Error("Delegated access is disabled for this guild.");
  if (!isDiscordSnowflake(input.guildId) || !isDiscordSnowflake(input.actorUserId)) {
    throw new Error("Invalid Discord ID.");
  }
  if (input.targetType !== "user" && input.targetType !== "role") {
    throw new Error("Invalid delegated access target type.");
  }
  if (input.accessLevel !== undefined && input.accessLevel !== "view" && input.accessLevel !== "edit") {
    throw new Error("Invalid delegated access level.");
  }
  await ensureDelegatedAccessTable();
  const ids = [...new Set(input.targetIds)].filter(isDiscordSnowflake);
  await prisma.$transaction(async (tx) => {
    for (const targetId of ids) {
      if (input.accessLevel) await tx.$executeRawUnsafe(`INSERT INTO ${TABLE} (guild_id,target_type,target_id,access_level,granted_by_user_id) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE access_level=VALUES(access_level), granted_by_user_id=VALUES(granted_by_user_id)`, input.guildId, input.targetType, targetId, input.accessLevel, input.actorUserId);
      else await tx.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE guild_id=? AND target_type=? AND target_id=?`, input.guildId, input.targetType, targetId);
    }
  });
}
