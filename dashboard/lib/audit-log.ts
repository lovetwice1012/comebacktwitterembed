import "server-only";

import crypto from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { getAuditHashSecret } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import type { AuditActor } from "@/lib/types";

const AUDIT_SQL = `CREATE TABLE IF NOT EXISTS dashboard_audit_logs (
  audit_log_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  guild_id VARCHAR(32) NOT NULL,
  provider_id VARCHAR(64) NULL,
  setting_key VARCHAR(191) NULL,
  actor_user_id VARCHAR(32) NOT NULL,
  actor_username_snapshot VARCHAR(255) NULL,
  action VARCHAR(64) NOT NULL,
  before_json LONGTEXT NULL,
  after_json LONGTEXT NULL,
  request_id VARCHAR(64) NULL,
  ip_hash CHAR(64) NULL,
  user_agent_hash CHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_dashboard_audit_guild_time (guild_id, created_at),
  INDEX idx_dashboard_audit_actor_time (actor_user_id, created_at),
  INDEX idx_dashboard_audit_provider_time (provider_id, created_at),
  INDEX idx_dashboard_audit_setting_time (setting_key, created_at)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`;

type Tx = Prisma.TransactionClient | PrismaClient;

export async function ensureAuditLogTable(db: Tx = prisma) {
  await db.$executeRawUnsafe(AUDIT_SQL);
}

function hashValue(value: string | null | undefined) {
  if (!value) return null;
  const secret = getAuditHashSecret();
  return crypto.createHash("sha256").update(secret).update(value).digest("hex");
}

function json(value: unknown) {
  return value === undefined ? null : JSON.stringify(value);
}

export async function recordAuditLog(
  db: Tx,
  input: {
    guildId: string;
    providerId?: string | null;
    settingKey?: string | null;
    actor: AuditActor;
    action: string;
    before?: unknown;
    after?: unknown;
    requestId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  },
) {
  await ensureAuditLogTable(db);
  await db.$executeRaw`
    INSERT INTO dashboard_audit_logs
      (guild_id, provider_id, setting_key, actor_user_id, actor_username_snapshot, action, before_json, after_json, request_id, ip_hash, user_agent_hash)
    VALUES
      (${input.guildId}, ${input.providerId || null}, ${input.settingKey || null}, ${input.actor.id}, ${input.actor.username || null}, ${input.action}, ${json(input.before)}, ${json(input.after)}, ${input.requestId || null}, ${hashValue(input.ip)}, ${hashValue(input.userAgent)})
  `;
}

export async function listAuditLogs(guildId: string, filters: Record<string, string | undefined>) {
  await ensureAuditLogTable();
  const clauses = ["guild_id = ?"];
  const params: unknown[] = [guildId];

  for (const [column, value] of [
    ["provider_id", filters.provider_id],
    ["setting_key", filters.setting_key],
    ["actor_user_id", filters.actor_user_id],
    ["action", filters.action],
  ] as const) {
    if (!value) continue;
    clauses.push(`${column} = ?`);
    params.push(value);
  }
  if (filters.date_from) {
    clauses.push("created_at >= ?");
    params.push(new Date(filters.date_from));
  }
  if (filters.date_to) {
    clauses.push("created_at <= ?");
    params.push(new Date(filters.date_to));
  }

  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT audit_log_id, guild_id, provider_id, setting_key, actor_user_id, actor_username_snapshot, action, before_json, after_json, request_id, created_at
     FROM dashboard_audit_logs
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT 200`,
    ...params,
  );

  return rows.map((row) => ({
    auditLogId: String(row.audit_log_id),
    guildId: row.guild_id,
    providerId: row.provider_id,
    settingKey: row.setting_key,
    actorUserId: row.actor_user_id,
    actorUsernameSnapshot: row.actor_username_snapshot,
    action: row.action,
    before: parseJson(row.before_json),
    after: parseJson(row.after_json),
    requestId: row.request_id,
    createdAt: row.created_at,
  }));
}

function parseJson(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
