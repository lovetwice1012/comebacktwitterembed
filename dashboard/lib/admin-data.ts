import "server-only";

import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { getBotToken, getClientId, getDashboardAdminAnalyticsPrewarm, getDatabaseUrl } from "@/lib/env";
import { ensureAuditLogTable } from "@/lib/audit-log";
import { fetchBotGuildIds } from "@/lib/discord";
import { getCatalog, getProvider, getProviderSpecs, providerLabel, text } from "@/lib/settings-catalog";
import { getProviderSettingsState, saveProviderSettings } from "@/lib/settings-db";
import type { AuditActor, SettingValue } from "@/lib/types";
import type { DashboardLocale } from "@/lib/i18n";

const MAX_LIMIT = 200;
type Row = Record<string, unknown>;
type PreviewUrlVisibility = "normalized" | "raw";

const DATABASE_TABLES = [
  { name: "schema_migrations", label: "Schema migrations", orderBy: "applied_at" },
  { name: "users", label: "Users", orderBy: "updated_at" },
  { name: "providers", label: "Providers", orderBy: "created_at" },
  { name: "guilds", label: "Guilds", orderBy: "created_at" },
  { name: "twitter_accounts", label: "Twitter accounts", orderBy: "created_at" },
  { name: "webhook_endpoints", label: "Webhook endpoints", orderBy: "updated_at" },
  { name: "auto_extract_targets", label: "Auto extract targets", orderBy: "updated_at" },
  { name: "guild_provider_settings", label: "Guild provider settings", orderBy: "updated_at" },
  { name: "guild_provider_disable_targets", label: "Provider disable targets", orderBy: "created_at" },
  { name: "guild_provider_banned_words", label: "Provider banned words", orderBy: "created_at" },
  { name: "guild_provider_button_visibility", label: "Button visibility", orderBy: "updated_at" },
  { name: "guild_provider_button_disabled_targets", label: "Button disabled targets", orderBy: "created_at" },
  { name: "deregister_notifications", label: "Deregister notifications", orderBy: "created_at" },
  { name: "bot_error_events", label: "Bot error events", orderBy: "created_at" },
  { name: "bot_error_buckets", label: "Bot error buckets", orderBy: "updated_at" },
  { name: "bot_metric_buckets", label: "Bot metric buckets", orderBy: "updated_at" },
  { name: "bot_analytics_events", label: "Bot analytics events", orderBy: "created_at" },
  { name: "bot_provider_content_events", label: "Provider content events", orderBy: "created_at" },
  { name: "bot_provider_content_facets", label: "Provider content facets", orderBy: "created_at" },
  { name: "bot_provider_hourly_aggregates", label: "Provider hourly aggregates", orderBy: "updated_at" },
  { name: "bot_provider_hourly_unique_keys", label: "Provider hourly unique keys", orderBy: "created_at" },
  { name: "bot_error_alerts", label: "Bot error alerts", orderBy: "updated_at" },
  { name: "dashboard_audit_logs", label: "Dashboard audit logs", orderBy: "created_at" },
] as const;

const tableMap = new Map<string, (typeof DATABASE_TABLES)[number]>(DATABASE_TABLES.map((table) => [table.name, table]));
const sensitiveColumn = /(token|secret|password|webhook_url)$/i;
const personalIdentifierColumn = /(^|_)(author_user_id|actor_user_id|user_id|target_user_id|message_id)$/i;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ADMIN_ANALYTICS_BATCH_INTERVAL_MS = 5 * 60 * 1000;
const ADMIN_OVERVIEW_REFRESH_INTERVAL_MS = ADMIN_ANALYTICS_BATCH_INTERVAL_MS;
const ADMIN_ANALYTICS_QUERY_CONCURRENCY = 2;
const ADMIN_ANALYTICS_CACHE_MAX_ENTRIES = 12;
const ADMIN_ANALYTICS_CACHE_ACTIVE_MS = 60 * 60 * 1000;
const ADMIN_ANALYTICS_BUILD_QUEUE_MAX = 4;
const ADMIN_ANALYTICS_BUILD_CONCURRENCY = 2;
const ADMIN_REPORT_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;
const PRIVACY_MIN_GROUP_SIZE = 5;
const SMALL_GROUP_LABEL = "少数";
const smallGroupDetailColumns = new Set([
  "author_user_id",
  "channel_id",
  "content_event_id",
  "content_id",
  "message_id",
]);
const privacyUserCountColumns = new Set([
  "users",
  "unique_users",
  "content_users",
  "shared_users",
  "target_users",
  "interest_users",
  "total_users",
  "active_users",
  "returning_users",
  "first_seen_users",
  "users_after",
  "retained_users",
  "cohort_users",
]);
const privacyCountColumns = new Set([...privacyUserCountColumns]);

const ANALYTICS_METRICS = [
  "provider_extract_attempt",
  "provider_extract_success",
  "provider_extract_error",
  "provider_extract_empty",
  "discord_send_attempt",
  "discord_send_success",
  "discord_send_error",
  "discord_send_permission_denied",
  "command_attempt",
  "command_success",
  "command_error",
  "component_attempt",
  "component_success",
  "component_error",
  "modal_submit_attempt",
  "modal_submit_success",
] as const;

export type AdminTableName = (typeof DATABASE_TABLES)[number]["name"];

function limitValue(value: string | number | null | undefined, fallback = 50) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function quoteIdentifier(name: string) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("Invalid identifier.");
  return `\`${name}\``;
}

function serialize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "function" || typeof value === "symbol") return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => serialize(item, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    try {
      const jsonValue = typeof (value as { toJSON?: unknown }).toJSON === "function"
        ? (value as { toJSON: () => unknown }).toJSON()
        : value;
      if (jsonValue !== value) return serialize(jsonValue, seen);
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialize(item, seen)]));
    } finally {
      seen.delete(value);
    }
  }
  return value;
}

function clientSafe<T>(value: T): T {
  return serialize(value) as T;
}

let cachedAnonymizationSalt: string | null = null;

function analyticsAnonymizationSalt() {
  if (!cachedAnonymizationSalt) {
    cachedAnonymizationSalt = process.env.ANALYTICS_ANONYMIZATION_SALT || getClientId() || "cbte-analytics-v1";
  }
  return cachedAnonymizationSalt;
}

function anonymizedPrefix(key: string) {
  if (/message_id$/i.test(key)) return "msg";
  if (/guild_id$/i.test(key)) return "guild";
  if (/channel_id$/i.test(key)) return "channel";
  if (/content(_event)?_id$/i.test(key)) return "content";
  return "user";
}

function anonymizeIdentifier(value: unknown, key: string) {
  if (value === undefined || value === null || value === "") return value;
  const digest = createHash("sha256")
    .update(`${analyticsAnonymizationSalt()}:${String(value)}`)
    .digest("hex")
    .slice(0, 12);
  return `${anonymizedPrefix(key)}_${digest}`;
}

function parseJson(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function maskRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (sensitiveColumn.test(key)) return [key, value ? "[masked]" : value];
      const serialized = serialize(value);
      if (personalIdentifierColumn.test(key)) return [key, anonymizeIdentifier(serialized, key)];
      return [key, serialized];
    }),
  );
}

function finiteRowNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function hasSmallPrivacyGroup(row: Row) {
  for (const key of privacyCountColumns) {
    const numeric = finiteRowNumber(row[key]);
    if (numeric !== null && numeric < PRIVACY_MIN_GROUP_SIZE) return true;
  }
  return false;
}

function protectSmallGroupRow(row: Row, extraDetailColumns: string[] = []) {
  if (!hasSmallPrivacyGroup(row)) return row;

  const protectedColumns = new Set([...smallGroupDetailColumns, ...extraDetailColumns]);
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (protectedColumns.has(key)) return [key, SMALL_GROUP_LABEL];
      return [key, value];
    }),
  );
}

function protectSmallGroupRows(rows: Row[], extraDetailColumns: string[] = []) {
  return rows.map((row) => protectSmallGroupRow(row, extraDetailColumns));
}

const previewHiddenDetailColumns = new Set([
  "author_user_id",
  "channel_id",
  "channel_name_snapshot",
  "content_event_id",
  "content_id",
  "guild_name_snapshot",
  "message_id",
  "source",
]);
const previewAnonymizedDetailColumns = new Set(["guild_id"]);

function protectUserFacingPreviewRow(row: Row, extraDetailColumns: string[] = []) {
  const smallGroupProtected = protectSmallGroupRow(row, extraDetailColumns);
  return Object.fromEntries(
    Object.entries(smallGroupProtected).flatMap(([key, value]) => {
      if (previewHiddenDetailColumns.has(key)) return [];
      if (previewAnonymizedDetailColumns.has(key) && value !== SMALL_GROUP_LABEL) {
        return [[key, anonymizeIdentifier(value, key)]];
      }
      return [[key, value]];
    }),
  );
}

function protectUserFacingPreviewRows(rows: Row[], extraDetailColumns: string[] = []) {
  return rows.map((row) => protectUserFacingPreviewRow(row, extraDetailColumns));
}

function previewUrlVisibility(value: unknown): PreviewUrlVisibility {
  return String(value || "").toLowerCase() === "raw" ? "raw" : "normalized";
}

function normalizedUrlForDisplay(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value);
  try {
    const url = new URL(text);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return text.split(/[?#]/)[0] || text;
  }
}

function applyPreviewUrlPolicyRow(row: Row, visibility: PreviewUrlVisibility) {
  const rawUrl = row.content_url ?? row.raw_url ?? null;
  const normalizedUrl = row.normalized_url ?? normalizedUrlForDisplay(rawUrl);
  const displayUrl = visibility === "raw" ? (rawUrl ?? normalizedUrl) : normalizedUrl;
  const next: Row = {
    ...row,
    url_display: displayUrl,
    url_visibility: visibility,
    url_query_visible: visibility === "raw" && rawUrl !== null && rawUrl !== normalizedUrl,
  };

  if (visibility === "normalized") {
    if ("content_url" in next) next.content_url = normalizedUrl;
    if ("raw_url" in next) next.raw_url = null;
    next.normalized_url = normalizedUrl;
  }

  return next;
}

function applyPreviewUrlPolicyRows(rows: Row[], visibility: PreviewUrlVisibility) {
  return rows.map((row) => applyPreviewUrlPolicyRow(row, visibility));
}

async function scalarCount(sql: string, ...params: unknown[]) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(sql, ...params);
  const value = rows[0]?.count ?? rows[0]?.COUNT ?? rows[0]?.["COUNT(*)"] ?? 0;
  return Number(value);
}

async function tableCount(name: string) {
  try {
    return {
      table: name,
      label: tableMap.get(name)?.label || name,
      available: true,
      count: await scalarCount(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`),
    };
  } catch (error) {
    return {
      table: name,
      label: tableMap.get(name)?.label || name,
      available: false,
      count: 0,
      error: error instanceof Error ? error.message : "Unavailable",
    };
  }
}

async function optionalQuery<T>(fallback: T, load: () => Promise<T>) {
  try {
    return await load();
  } catch {
    return fallback;
  }
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function runLimited<const Tasks extends readonly (() => Promise<unknown>)[]>(
  tasks: Tasks,
  concurrency = ADMIN_ANALYTICS_QUERY_CONCURRENCY,
): Promise<{ [Index in keyof Tasks]: Awaited<ReturnType<Tasks[Index]>> }> {
  const results = new Array<unknown>(tasks.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      await yieldToEventLoop();
      results[index] = await tasks[index]();
    }
  }));
  return results as { [Index in keyof Tasks]: Awaited<ReturnType<Tasks[Index]>> };
}

type AdminAnalyticsBuildJob<T> = {
  build: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

let adminAnalyticsPendingBuilds = 0;
let adminAnalyticsRunningBuilds = 0;
const adminAnalyticsBuildJobs: AdminAnalyticsBuildJob<unknown>[] = [];

function runNextAdminAnalyticsBuild() {
  while (adminAnalyticsRunningBuilds < ADMIN_ANALYTICS_BUILD_CONCURRENCY && adminAnalyticsBuildJobs.length) {
    const job = adminAnalyticsBuildJobs.shift();
    if (!job) return;
    adminAnalyticsRunningBuilds += 1;
    void (async () => {
      try {
        job.resolve(await job.build());
      } catch (error) {
        job.reject(error);
      } finally {
        adminAnalyticsRunningBuilds = Math.max(0, adminAnalyticsRunningBuilds - 1);
        adminAnalyticsPendingBuilds = Math.max(0, adminAnalyticsPendingBuilds - 1);
        runNextAdminAnalyticsBuild();
      }
    })();
  }
}

function enqueueAdminAnalyticsBuild<T>(build: () => Promise<T>) {
  if (adminAnalyticsPendingBuilds >= ADMIN_ANALYTICS_BUILD_QUEUE_MAX) {
    return Promise.reject(new Error("Admin analytics build queue is saturated."));
  }
  adminAnalyticsPendingBuilds += 1;
  return new Promise<T>((resolve, reject) => {
    adminAnalyticsBuildJobs.push({
      build: async () => {
        await yieldToEventLoop();
        return build();
      },
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    runNextAdminAnalyticsBuild();
  });
}

function shouldPrewarmAdminAnalyticsCache() {
  return getDashboardAdminAnalyticsPrewarm();
}

function rate(numerator: unknown, denominator: unknown) {
  const top = Number(numerator) || 0;
  const bottom = Number(denominator) || 0;
  return bottom > 0 ? top / bottom : 0;
}

function optionalRate(numerator: unknown, denominator: unknown) {
  const top = Number(numerator) || 0;
  const bottom = Number(denominator) || 0;
  return bottom > 0 ? top / bottom : null;
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function metricSelect(name: string, alias: string) {
  return `SUM(CASE WHEN metric_name = '${name}' THEN count ELSE 0 END) AS ${alias}`;
}

function analyticsMetricPlaceholders() {
  return ANALYTICS_METRICS.map(() => "?").join(", ");
}

function metricParams(startMs: number, extra: unknown[] = []) {
  return [startMs, ...extra, ...ANALYTICS_METRICS];
}

async function getMetricTotals(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT metric_name, SUM(count) AS count
     FROM bot_metric_buckets
     WHERE bucket_start_ms >= ?
     GROUP BY metric_name
     ORDER BY count DESC
     LIMIT 50`,
    startMs,
  );
  return rows.map(maskRow);
}

async function getProviderAnalytics(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       provider_id,
       ${metricSelect("provider_extract_attempt", "extract_attempts")},
       ${metricSelect("provider_extract_success", "extract_successes")},
       ${metricSelect("provider_extract_error", "extract_errors")},
       ${metricSelect("provider_extract_empty", "extract_empty")},
       ${metricSelect("discord_send_attempt", "send_attempts")},
       ${metricSelect("discord_send_success", "send_successes")},
       ${metricSelect("discord_send_error", "send_errors")},
       ${metricSelect("discord_send_permission_denied", "permission_denied")}
     FROM bot_metric_buckets
     WHERE bucket_start_ms >= ?
       AND provider_id <> ''
       AND metric_name IN (${analyticsMetricPlaceholders()})
     GROUP BY provider_id
     ORDER BY extract_attempts DESC, send_attempts DESC
     LIMIT 30`,
    ...metricParams(startMs),
  );
  return rows.map((row) => ({
    ...maskRow(row),
    extract_success_rate: rate(row.extract_successes, row.extract_attempts),
    extract_error_rate: rate(row.extract_errors, row.extract_attempts),
    send_success_rate: rate(row.send_successes, row.send_attempts),
    send_error_rate: rate(row.send_errors, row.send_attempts),
  }));
}

async function getHourlyTrend(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       FLOOR(bucket_start_ms / ${HOUR_MS}) * ${HOUR_MS} AS hour_start_ms,
       ${metricSelect("provider_extract_attempt", "extract_attempts")},
       ${metricSelect("provider_extract_success", "extract_successes")},
       ${metricSelect("provider_extract_error", "extract_errors")},
       ${metricSelect("discord_send_attempt", "send_attempts")},
       ${metricSelect("discord_send_success", "send_successes")},
       ${metricSelect("discord_send_error", "send_errors")},
       ${metricSelect("command_attempt", "command_attempts")},
       ${metricSelect("command_success", "command_successes")},
       ${metricSelect("command_error", "command_errors")},
       ${metricSelect("component_attempt", "component_attempts")},
       ${metricSelect("component_success", "component_successes")},
       ${metricSelect("component_error", "component_errors")}
     FROM bot_metric_buckets
     WHERE bucket_start_ms >= ?
       AND metric_name IN (${analyticsMetricPlaceholders()})
     GROUP BY hour_start_ms
     ORDER BY hour_start_ms ASC`,
    ...metricParams(startMs),
  );
  return rows.map((row) => ({
    ...maskRow(row),
    extract_success_rate: rate(row.extract_successes, row.extract_attempts),
    send_success_rate: rate(row.send_successes, row.send_attempts),
    command_success_rate: rate(row.command_successes, row.command_attempts),
    component_success_rate: rate(row.component_successes, row.component_attempts),
  }));
}

async function getTopGuildAnalytics(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       guild_id,
       ${metricSelect("provider_extract_attempt", "extract_attempts")},
       ${metricSelect("provider_extract_error", "extract_errors")},
       ${metricSelect("discord_send_attempt", "send_attempts")},
       ${metricSelect("discord_send_error", "send_errors")},
       ${metricSelect("command_attempt", "command_attempts")},
       ${metricSelect("component_attempt", "component_attempts")}
     FROM bot_metric_buckets
     WHERE bucket_start_ms >= ?
       AND guild_id <> ''
       AND metric_name IN (${analyticsMetricPlaceholders()})
     GROUP BY guild_id
     ORDER BY (extract_attempts + send_attempts + command_attempts + component_attempts) DESC
     LIMIT 30`,
    ...metricParams(startMs),
  );
  return rows.map((row) => ({
    ...maskRow(row),
    total_activity:
      Number(row.extract_attempts || 0)
      + Number(row.send_attempts || 0)
      + Number(row.command_attempts || 0)
      + Number(row.component_attempts || 0),
    extract_error_rate: rate(row.extract_errors, row.extract_attempts),
    send_error_rate: rate(row.send_errors, row.send_attempts),
  }));
}

async function getEndpointAnalytics(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       provider_id,
       endpoint_key,
       ${metricSelect("provider_extract_attempt", "extract_attempts")},
       ${metricSelect("provider_extract_success", "extract_successes")},
       ${metricSelect("provider_extract_error", "extract_errors")}
     FROM bot_metric_buckets
     WHERE bucket_start_ms >= ?
       AND endpoint_key <> ''
       AND metric_name IN (${analyticsMetricPlaceholders()})
     GROUP BY provider_id, endpoint_key
     ORDER BY extract_attempts DESC, extract_errors DESC
     LIMIT 30`,
    ...metricParams(startMs),
  );
  return rows.map((row) => ({
    ...maskRow(row),
    extract_success_rate: rate(row.extract_successes, row.extract_attempts),
    extract_error_rate: rate(row.extract_errors, row.extract_attempts),
  }));
}

async function getAuditAnalytics(startMs: number) {
  const [actions, actors, guilds] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT action, COUNT(*) AS count
       FROM dashboard_audit_logs
       WHERE created_at >= ?
       GROUP BY action
       ORDER BY count DESC
       LIMIT 20`,
      new Date(startMs),
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT actor_user_id, actor_username_snapshot, COUNT(*) AS count
       FROM dashboard_audit_logs
       WHERE created_at >= ?
       GROUP BY actor_user_id, actor_username_snapshot
       ORDER BY count DESC
       LIMIT 20`,
      new Date(startMs),
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT guild_id, COUNT(*) AS count
       FROM dashboard_audit_logs
       WHERE created_at >= ?
       GROUP BY guild_id
       ORDER BY count DESC
       LIMIT 20`,
      new Date(startMs),
    ),
  ]);
  return {
    actions: actions.map(maskRow),
    actors: actors.map(maskRow),
    guilds: guilds.map(maskRow),
  };
}

async function getCommandAndComponentErrors(startMs: number) {
  const [commands, components, httpStatuses] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT command_name, error_type, COUNT(*) AS count
       FROM bot_error_events
       WHERE occurred_at_ms >= ? AND command_name IS NOT NULL
       GROUP BY command_name, error_type
       ORDER BY count DESC
       LIMIT 30`,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT component_id, error_type, COUNT(*) AS count
       FROM bot_error_events
       WHERE occurred_at_ms >= ? AND component_id IS NOT NULL
       GROUP BY component_id, error_type
       ORDER BY count DESC
       LIMIT 30`,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT provider_id, http_status, COUNT(*) AS count
       FROM bot_error_events
       WHERE occurred_at_ms >= ? AND http_status IS NOT NULL
       GROUP BY provider_id, http_status
       ORDER BY count DESC
       LIMIT 30`,
      startMs,
    ),
  ]);
  return {
    commands: commands.map(maskRow),
    components: components.map(maskRow),
    httpStatuses: httpStatuses.map(maskRow),
  };
}

async function getAnalyticsQualityDashboard(startMs: number) {
  const [
    missingNativeAnalytics,
    enrichmentReliability,
    extractVsEnrichment,
    enrichmentSchemaVersions,
    enrichmentQueueOutcomes,
    providerRateLimits,
    providerDataErrors,
    metricNullRates,
    metricObservationQuality,
    metricSchemaDrift,
    enrichmentSlo,
  ] = await Promise.all([
    optionalQuery([], async () => {
      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT
           provider_id,
           SUM(CASE WHEN metric_name = 'provider_analytics_missing' THEN count ELSE 0 END) AS missing_events,
           SUM(CASE WHEN metric_name = 'provider_extract_success' THEN count ELSE 0 END) AS extract_successes
         FROM bot_metric_buckets
         WHERE bucket_start_ms >= ?
           AND provider_id <> ''
           AND metric_name IN ('provider_analytics_missing', 'provider_extract_success')
         GROUP BY provider_id
         ORDER BY missing_events DESC, extract_successes DESC
         LIMIT 80`,
        startMs,
      );
      return rows.map((row) => ({
        ...maskRow(row),
        missing_rate: rate(row.missing_events, row.extract_successes),
      }));
    }),
    optionalQuery([], async () => {
      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT
           provider_id,
           account_key,
           source,
           COUNT(*) AS jobs,
           SUM(success = 1) AS successes,
           SUM(success = 0) AS failures,
           AVG(duration_ms) AS avg_duration_ms,
           MAX(duration_ms) AS max_duration_ms
         FROM bot_analytics_events
         WHERE occurred_at_ms >= ?
           AND event_type = 'provider_analytics_enrichment'
         GROUP BY provider_id, account_key, source
         ORDER BY jobs DESC
         LIMIT 80`,
        startMs,
      );
      return rows.map((row) => ({
        ...maskRow(row),
        success_rate: rate(row.successes, Number(row.successes || 0) + Number(row.failures || 0)),
        failure_rate: rate(row.failures, Number(row.successes || 0) + Number(row.failures || 0)),
      }));
    }),
    optionalQuery([], async () => {
      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT
           provider_id,
           SUM(event_type = 'provider_extract') AS extract_events,
           SUM(event_type = 'provider_extract' AND success = 1) AS extract_successes,
           SUM(event_type = 'provider_extract' AND success = 0) AS extract_failures,
           AVG(CASE WHEN event_type = 'provider_extract' THEN duration_ms ELSE NULL END) AS avg_extract_duration_ms,
           MAX(CASE WHEN event_type = 'provider_extract' THEN duration_ms ELSE NULL END) AS max_extract_duration_ms,
           SUM(event_type = 'provider_analytics_enrichment') AS enrichment_jobs,
           SUM(event_type = 'provider_analytics_enrichment' AND success = 1) AS enrichment_successes,
           SUM(event_type = 'provider_analytics_enrichment' AND success = 0) AS enrichment_failures,
           AVG(CASE WHEN event_type = 'provider_analytics_enrichment' THEN duration_ms ELSE NULL END) AS avg_enrichment_duration_ms,
           MAX(CASE WHEN event_type = 'provider_analytics_enrichment' THEN duration_ms ELSE NULL END) AS max_enrichment_duration_ms
         FROM bot_analytics_events
         WHERE occurred_at_ms >= ?
           AND event_type IN ('provider_extract', 'provider_analytics_enrichment')
           AND provider_id IS NOT NULL
         GROUP BY provider_id
         ORDER BY extract_events DESC, enrichment_jobs DESC
         LIMIT 80`,
        startMs,
      );
      return rows.map((row) => ({
        ...maskRow(row),
        extract_success_rate: rate(row.extract_successes, Number(row.extract_successes || 0) + Number(row.extract_failures || 0)),
        enrichment_success_rate: rate(row.enrichment_successes, Number(row.enrichment_successes || 0) + Number(row.enrichment_failures || 0)),
      }));
    }),
    optionalQuery([], async () => {
      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT
           provider_id,
           COALESCE(JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.schema_version')), 'unknown') AS schema_version,
           COUNT(*) AS jobs,
           SUM(success = 1) AS successes,
           SUM(success = 0) AS failures,
           AVG(duration_ms) AS avg_duration_ms
         FROM bot_analytics_events
         WHERE occurred_at_ms >= ?
           AND event_type = 'provider_analytics_enrichment'
         GROUP BY provider_id, schema_version
         ORDER BY jobs DESC
         LIMIT 80`,
        startMs,
      );
      return rows.map((row) => ({
        ...maskRow(row),
        success_rate: rate(row.successes, Number(row.successes || 0) + Number(row.failures || 0)),
      }));
    }),
    optionalQuery([], async () => {
      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT
           provider_id,
           account_key,
           source,
           COALESCE(JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.outcome')), IF(success = 1, 'success', 'error')) AS outcome,
           COUNT(*) AS attempts,
           SUM(JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.will_retry')) = 'true') AS retried_attempts,
           AVG(CAST(JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.queue_wait_ms')) AS UNSIGNED)) AS avg_queue_wait_ms,
           MAX(CAST(JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.retry_delay_ms')) AS UNSIGNED)) AS max_retry_delay_ms
         FROM bot_analytics_events
         WHERE occurred_at_ms >= ?
           AND event_type = 'provider_analytics_enrichment'
         GROUP BY provider_id, account_key, source, outcome
         ORDER BY attempts DESC
         LIMIT 80`,
        startMs,
      );
      return rows.map(maskRow);
    }),
    optionalQuery([], async () => {
      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT
           provider_id,
           account_key,
           source,
           COUNT(*) AS rate_limited_attempts,
           SUM(JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.will_retry')) = 'true') AS retried_attempts,
           AVG(duration_ms) AS avg_duration_ms,
           MAX(CAST(JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.retry_delay_ms')) AS UNSIGNED)) AS max_retry_delay_ms,
           MAX(occurred_at_ms) AS latest_ms
         FROM bot_analytics_events
         WHERE occurred_at_ms >= ?
           AND event_type = 'provider_analytics_enrichment'
           AND JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.outcome')) = 'rate_limited'
         GROUP BY provider_id, account_key, source
         ORDER BY rate_limited_attempts DESC
         LIMIT 80`,
        startMs,
      );
      return rows.map(maskRow);
    }),
    optionalQuery([], async () => {
      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT
           provider_id,
           error_type,
           source,
           COUNT(*) AS errors
         FROM bot_error_events
         WHERE occurred_at_ms >= ?
           AND (
             error_type IN ('provider_api_json_decode_error', 'provider_api_http_error', 'provider_analytics_missing', 'provider_analytics_enrichment_failed')
             OR error_type LIKE 'provider_api_%'
             OR error_type LIKE 'provider_analytics_%'
             OR source LIKE 'provider.%'
           )
         GROUP BY provider_id, error_type, source
         ORDER BY errors DESC
         LIMIT 80`,
        startMs,
      );
      return rows.map(maskRow);
    }),
    optionalQuery([], () => getProviderMetricNullRates(startMs)),
    optionalQuery([], () => getProviderMetricObservationQuality(startMs)),
    optionalQuery([], () => getProviderMetricSchemaDrift(startMs)),
    optionalQuery([], () => getProviderEnrichmentSloDashboard(startMs)),
  ]);
  const requiredMetricCoverage = getProviderRequiredMetricCoverage(metricNullRates);
  return {
    missingNativeAnalytics,
    enrichmentReliability,
    extractVsEnrichment,
    enrichmentSchemaVersions,
    enrichmentQueueOutcomes,
    providerRateLimits,
    providerDataErrors,
    metricNullRates,
    metricObservationQuality,
    requiredMetricCoverage,
    metricSchemaDrift,
    enrichmentSlo,
  };
}

async function getDerivedAggregateStatus(startMs: number) {
  const [summaryRows, providerRows, schemaRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         (SELECT COUNT(*) FROM bot_analytics_events WHERE occurred_at_ms >= ?) AS raw_analytics_events,
         (SELECT COUNT(*) FROM bot_provider_content_events WHERE occurred_at_ms >= ?) AS raw_content_events,
         (SELECT MAX(occurred_at_ms) FROM bot_analytics_events WHERE occurred_at_ms >= ?) AS latest_raw_analytics_ms,
         (SELECT MAX(occurred_at_ms) FROM bot_provider_content_events WHERE occurred_at_ms >= ?) AS latest_raw_content_ms,
         COUNT(*) AS aggregate_rows,
         SUM(analytics_events) AS aggregate_analytics_events,
         SUM(content_events) AS aggregate_content_events,
         SUM(enrichment_jobs) AS aggregate_enrichment_jobs,
         MIN(bucket_start_ms) AS first_bucket_ms,
         MAX(bucket_start_ms) AS latest_bucket_ms,
         MAX(updated_at) AS latest_updated_at
       FROM bot_provider_hourly_aggregates
       WHERE bucket_start_ms >= ?`,
      startMs,
      startMs,
      startMs,
      startMs,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         provider_id,
         SUM(content_events) AS content_events,
         SUM(analytics_events) AS analytics_events,
         SUM(extract_events) AS extract_events,
         SUM(enrichment_jobs) AS enrichment_jobs,
         SUM(enrichment_failures) AS enrichment_failures,
         SUM(analytics_duration_sum_ms) / NULLIF(SUM(analytics_duration_count), 0) AS avg_analytics_duration_ms,
         SUM(enrichment_duration_sum_ms) / NULLIF(SUM(enrichment_duration_count), 0) AS avg_enrichment_duration_ms,
         MAX(bucket_start_ms) AS latest_bucket_ms
       FROM bot_provider_hourly_aggregates
       WHERE bucket_start_ms >= ?
         AND provider_id <> ''
       GROUP BY provider_id
       ORDER BY (content_events + analytics_events) DESC
       LIMIT 80`,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         provider_id,
         schema_version,
         SUM(enrichment_jobs) AS enrichment_jobs,
         SUM(enrichment_successes) AS enrichment_successes,
         SUM(enrichment_failures) AS enrichment_failures,
         SUM(enrichment_duration_sum_ms) / NULLIF(SUM(enrichment_duration_count), 0) AS avg_enrichment_duration_ms,
         MAX(bucket_start_ms) AS latest_bucket_ms
       FROM bot_provider_hourly_aggregates
       WHERE bucket_start_ms >= ?
         AND event_type = 'provider_analytics_enrichment'
       GROUP BY provider_id, schema_version
       ORDER BY enrichment_jobs DESC
       LIMIT 80`,
      startMs,
    ),
  ]);
  const summary = summaryRows[0] || {};
  const latestRawMs = Math.max(Number(summary.latest_raw_analytics_ms || 0), Number(summary.latest_raw_content_ms || 0));
  const latestAggregateMs = Number(summary.latest_bucket_ms || 0);
  const aggregateLagMs = latestRawMs > 0 && latestAggregateMs > 0 ? Math.max(0, latestRawMs - latestAggregateMs) : null;
  return {
    summary: {
      ...maskRow(summary),
      analytics_event_coverage_rate: rate(summary.aggregate_analytics_events, summary.raw_analytics_events),
      content_event_coverage_rate: rate(summary.aggregate_content_events, summary.raw_content_events),
      aggregate_lag_ms: aggregateLagMs,
      aggregate_lag_hours: aggregateLagMs === null ? null : rate(aggregateLagMs, HOUR_MS),
      aggregate_stale: aggregateLagMs !== null && aggregateLagMs > 2 * HOUR_MS ? 1 : 0,
      data_source: "bot_provider_hourly_aggregates",
    },
    providers: providerRows.map((row) => ({
      ...maskRow(row),
      enrichment_failure_rate: rate(row.enrichment_failures, row.enrichment_jobs),
    })),
    schemaVersions: schemaRows.map((row) => ({
      ...maskRow(row),
      enrichment_success_rate: rate(row.enrichment_successes, Number(row.enrichment_successes || 0) + Number(row.enrichment_failures || 0)),
    })),
  };
}

function aggregateUniqueKey(providerId: unknown, accountKey: unknown, bucketStartMs?: unknown, contentType?: unknown) {
  return [providerId || "", accountKey || "", bucketStartMs || "", contentType || ""].join("\u0001");
}

function setAggregateUnique(uniqueMap: Map<string, Row>, key: string, keyType: unknown, count: unknown) {
  const current = uniqueMap.get(key) || {};
  if (keyType === "author_user") current.unique_users = count;
  if (keyType === "guild") current.unique_guilds = count;
  if (keyType === "url") current.unique_urls = count;
  uniqueMap.set(key, current);
}

function decorateAggregateOperationalRow(row: Row, extra: Row = {}) {
  const contentEvents = rowNumber(row, "content_events");
  const analyticsEvents = rowNumber(row, "analytics_events");
  const bucketStartMs = rowNumber(row, "bucket_start_ms");
  return maskRow({
    ...row,
    ...extra,
    ...(bucketStartMs > 0 ? { bucket_at: new Date(bucketStartMs).toISOString() } : {}),
    extract_success_rate: rate(row.extract_successes, row.extract_events),
    send_success_rate: rate(row.send_successes, row.send_events),
    enrichment_success_rate: rate(row.enrichment_successes, row.enrichment_jobs),
    sensitive_rate: rate(row.sensitive_events, contentEvents),
    analytics_per_content: rate(analyticsEvents, contentEvents),
    avg_analytics_duration_ms: rate(row.analytics_duration_sum_ms, row.analytics_duration_count),
    avg_enrichment_duration_ms: rate(row.enrichment_duration_sum_ms, row.enrichment_duration_count),
    avg_media_count: rate(row.media_count_sum, contentEvents),
    avg_duration_seconds: rate(row.duration_seconds_sum, row.duration_seconds_count),
    data_source: "bot_provider_hourly_aggregates",
    unique_data_source: "bot_provider_hourly_unique_keys",
  });
}

async function getAggregateOperationalTrend(startMs: number) {
  const [
    hourlyRows,
    hourlyUniqueRows,
    providerAccountRows,
    providerAccountUniqueRows,
    contentTypeRows,
    contentTypeUniqueRows,
  ] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         bucket_start_ms,
         COUNT(*) AS aggregate_rows,
         COUNT(DISTINCT NULLIF(provider_id, '')) AS providers,
         COUNT(DISTINCT NULLIF(account_key, '')) AS accounts,
         SUM(content_events) AS content_events,
         SUM(analytics_events) AS analytics_events,
         SUM(extract_events) AS extract_events,
         SUM(extract_successes) AS extract_successes,
         SUM(extract_failures) AS extract_failures,
         SUM(send_events) AS send_events,
         SUM(send_successes) AS send_successes,
         SUM(send_failures) AS send_failures,
         SUM(enrichment_jobs) AS enrichment_jobs,
         SUM(enrichment_successes) AS enrichment_successes,
         SUM(enrichment_failures) AS enrichment_failures,
         SUM(analytics_duration_sum_ms) AS analytics_duration_sum_ms,
         SUM(analytics_duration_count) AS analytics_duration_count,
         MAX(analytics_duration_max_ms) AS analytics_duration_max_ms,
         SUM(enrichment_duration_sum_ms) AS enrichment_duration_sum_ms,
         SUM(enrichment_duration_count) AS enrichment_duration_count,
         MAX(enrichment_duration_max_ms) AS enrichment_duration_max_ms,
         SUM(media_count_sum) AS media_count_sum,
         SUM(duration_seconds_sum) AS duration_seconds_sum,
         SUM(duration_seconds_count) AS duration_seconds_count,
         SUM(sensitive_events) AS sensitive_events
       FROM bot_provider_hourly_aggregates
       WHERE bucket_start_ms >= ?
       GROUP BY bucket_start_ms
       ORDER BY bucket_start_ms ASC
       LIMIT 240`,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         bucket_start_ms,
         key_type,
         COUNT(DISTINCT key_hash) AS unique_count
       FROM bot_provider_hourly_unique_keys
       WHERE bucket_start_ms >= ?
       GROUP BY bucket_start_ms, key_type`,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         provider_id,
         account_key,
         COUNT(DISTINCT bucket_start_ms) AS active_buckets,
         MIN(bucket_start_ms) AS first_bucket_ms,
         MAX(bucket_start_ms) AS latest_bucket_ms,
         SUM(content_events) AS content_events,
         SUM(analytics_events) AS analytics_events,
         SUM(extract_events) AS extract_events,
         SUM(extract_successes) AS extract_successes,
         SUM(extract_failures) AS extract_failures,
         SUM(send_events) AS send_events,
         SUM(send_successes) AS send_successes,
         SUM(send_failures) AS send_failures,
         SUM(enrichment_jobs) AS enrichment_jobs,
         SUM(enrichment_successes) AS enrichment_successes,
         SUM(enrichment_failures) AS enrichment_failures,
         SUM(analytics_duration_sum_ms) AS analytics_duration_sum_ms,
         SUM(analytics_duration_count) AS analytics_duration_count,
         MAX(analytics_duration_max_ms) AS analytics_duration_max_ms,
         SUM(enrichment_duration_sum_ms) AS enrichment_duration_sum_ms,
         SUM(enrichment_duration_count) AS enrichment_duration_count,
         MAX(enrichment_duration_max_ms) AS enrichment_duration_max_ms,
         SUM(media_count_sum) AS media_count_sum,
         SUM(duration_seconds_sum) AS duration_seconds_sum,
         SUM(duration_seconds_count) AS duration_seconds_count,
         SUM(sensitive_events) AS sensitive_events,
         (SUM(content_events) + SUM(analytics_events) + SUM(enrichment_jobs)) AS operational_events
       FROM bot_provider_hourly_aggregates
       WHERE bucket_start_ms >= ?
         AND provider_id <> ''
         AND account_key <> ''
       GROUP BY provider_id, account_key
       ORDER BY operational_events DESC
       LIMIT 120`,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         provider_id,
         account_key,
         key_type,
         COUNT(DISTINCT key_hash) AS unique_count
       FROM bot_provider_hourly_unique_keys
       WHERE bucket_start_ms >= ?
         AND provider_id <> ''
         AND account_key <> ''
       GROUP BY provider_id, account_key, key_type`,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         provider_id,
         content_type,
         COUNT(DISTINCT NULLIF(account_key, '')) AS accounts,
         COUNT(DISTINCT bucket_start_ms) AS active_buckets,
         MIN(bucket_start_ms) AS first_bucket_ms,
         MAX(bucket_start_ms) AS latest_bucket_ms,
         SUM(content_events) AS content_events,
         SUM(media_count_sum) AS media_count_sum,
         SUM(duration_seconds_sum) AS duration_seconds_sum,
         SUM(duration_seconds_count) AS duration_seconds_count,
         SUM(sensitive_events) AS sensitive_events
       FROM bot_provider_hourly_aggregates
       WHERE bucket_start_ms >= ?
         AND event_type = 'provider_content'
         AND provider_id <> ''
         AND content_type <> ''
       GROUP BY provider_id, content_type
       ORDER BY content_events DESC
       LIMIT 120`,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         provider_id,
         content_type,
         key_type,
         COUNT(DISTINCT key_hash) AS unique_count
       FROM bot_provider_hourly_unique_keys
       WHERE bucket_start_ms >= ?
         AND event_type = 'provider_content'
         AND provider_id <> ''
         AND content_type <> ''
       GROUP BY provider_id, content_type, key_type`,
      startMs,
    ),
  ]);

  const hourlyUniqueMap = new Map<string, Row>();
  for (const row of hourlyUniqueRows) {
    setAggregateUnique(hourlyUniqueMap, aggregateUniqueKey("", "", row.bucket_start_ms), row.key_type, row.unique_count);
  }

  const providerAccountUniqueMap = new Map<string, Row>();
  for (const row of providerAccountUniqueRows) {
    setAggregateUnique(providerAccountUniqueMap, aggregateUniqueKey(row.provider_id, row.account_key), row.key_type, row.unique_count);
  }

  const contentTypeUniqueMap = new Map<string, Row>();
  for (const row of contentTypeUniqueRows) {
    setAggregateUnique(contentTypeUniqueMap, aggregateUniqueKey(row.provider_id, "", "", row.content_type), row.key_type, row.unique_count);
  }

  return {
    hourly: hourlyRows.map((row) =>
      decorateAggregateOperationalRow(
        row,
        hourlyUniqueMap.get(aggregateUniqueKey("", "", row.bucket_start_ms)) || {},
      ),
    ),
    providerAccounts: providerAccountRows.map((row) =>
      decorateAggregateOperationalRow(
        row,
        providerAccountUniqueMap.get(aggregateUniqueKey(row.provider_id, row.account_key)) || {},
      ),
    ),
    contentTypes: contentTypeRows.map((row) =>
      decorateAggregateOperationalRow(
        row,
        contentTypeUniqueMap.get(aggregateUniqueKey(row.provider_id, "", "", row.content_type)) || {},
      ),
    ),
  };
}

function aggregateSeasonalityKey(kind: "hour" | "weekday" | "provider_weekday", row: Row) {
  if (kind === "hour") return String(row.hour_utc ?? "");
  if (kind === "weekday") return String(row.weekday_utc ?? "");
  return [row.provider_id || "", row.weekday_utc || ""].join("\u0001");
}

function aggregateDayKey(row: Row) {
  return [row.provider_id || "", row.day_start_ms || ""].join("\u0001");
}

function decorateAggregateSeasonalityRow(row: Row, extra: Row = {}) {
  return decorateAggregateOperationalRow(row, {
    ...extra,
    analysis_model: "seasonality",
    aggregation_grain: row.provider_id ? "provider_weekday" : row.weekday_utc ? "weekday" : "hour",
  });
}

function decorateEventDaySpikeRows(rows: Row[], uniqueMap: Map<string, Row>, baselineByProvider?: Map<string, number>) {
  const globalBaseline = rate(
    rows.reduce((sum, row) => sum + rowNumber(row, "content_events"), 0),
    Math.max(1, rows.length),
  );
  return rows
    .map((row) => {
      const baseline = baselineByProvider?.get(String(row.provider_id || "")) ?? globalBaseline;
      const contentEvents = rowNumber(row, "content_events");
      const lift = baseline > 0 ? contentEvents / baseline : 0;
      return decorateAggregateOperationalRow(
        row,
        {
          ...(uniqueMap.get(aggregateDayKey(row)) || {}),
          day_at: row.day_start_ms ? new Date(Number(row.day_start_ms)).toISOString() : null,
          baseline_content_events_per_day: baseline,
          delta_content_events: contentEvents - baseline,
          event_day_lift: lift,
          event_day_score: contentEvents * lift,
          analysis_model: "event_day_seasonality",
        },
      );
    })
    .sort((left, right) => rowNumber(right, "event_day_score") - rowNumber(left, "event_day_score"));
}

async function getAggregateSeasonalityAnalytics(startMs: number) {
  const [
    hourRows,
    hourUniqueRows,
    weekdayRows,
    weekdayUniqueRows,
    providerWeekdayRows,
    providerWeekdayUniqueRows,
  ] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         FLOOR(MOD(FLOOR(bucket_start_ms / ?), 24)) AS hour_utc,
         COUNT(*) AS aggregate_rows,
         COUNT(DISTINCT NULLIF(provider_id, '')) AS providers,
         COUNT(DISTINCT NULLIF(account_key, '')) AS accounts,
         SUM(content_events) AS content_events,
         SUM(analytics_events) AS analytics_events,
         SUM(extract_events) AS extract_events,
         SUM(extract_successes) AS extract_successes,
         SUM(send_events) AS send_events,
         SUM(send_successes) AS send_successes,
         SUM(enrichment_jobs) AS enrichment_jobs,
         SUM(enrichment_successes) AS enrichment_successes,
         SUM(sensitive_events) AS sensitive_events,
         SUM(media_count_sum) AS media_count_sum,
         SUM(duration_seconds_sum) AS duration_seconds_sum,
         SUM(duration_seconds_count) AS duration_seconds_count,
         SUM(analytics_duration_sum_ms) AS analytics_duration_sum_ms,
         SUM(analytics_duration_count) AS analytics_duration_count,
         SUM(enrichment_duration_sum_ms) AS enrichment_duration_sum_ms,
         SUM(enrichment_duration_count) AS enrichment_duration_count
       FROM bot_provider_hourly_aggregates
       WHERE bucket_start_ms >= ?
       GROUP BY hour_utc
       ORDER BY hour_utc ASC`,
      HOUR_MS,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         FLOOR(MOD(FLOOR(bucket_start_ms / ?), 24)) AS hour_utc,
         key_type,
         COUNT(DISTINCT key_hash) AS unique_count
       FROM bot_provider_hourly_unique_keys
       WHERE bucket_start_ms >= ?
         AND event_type = 'provider_content'
       GROUP BY hour_utc, key_type`,
      HOUR_MS,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         DAYOFWEEK(FROM_UNIXTIME(bucket_start_ms / 1000)) AS weekday_utc,
         COUNT(*) AS aggregate_rows,
         COUNT(DISTINCT NULLIF(provider_id, '')) AS providers,
         COUNT(DISTINCT NULLIF(account_key, '')) AS accounts,
         SUM(content_events) AS content_events,
         SUM(analytics_events) AS analytics_events,
         SUM(extract_events) AS extract_events,
         SUM(extract_successes) AS extract_successes,
         SUM(send_events) AS send_events,
         SUM(send_successes) AS send_successes,
         SUM(enrichment_jobs) AS enrichment_jobs,
         SUM(enrichment_successes) AS enrichment_successes,
         SUM(sensitive_events) AS sensitive_events,
         SUM(media_count_sum) AS media_count_sum,
         SUM(duration_seconds_sum) AS duration_seconds_sum,
         SUM(duration_seconds_count) AS duration_seconds_count,
         SUM(analytics_duration_sum_ms) AS analytics_duration_sum_ms,
         SUM(analytics_duration_count) AS analytics_duration_count,
         SUM(enrichment_duration_sum_ms) AS enrichment_duration_sum_ms,
         SUM(enrichment_duration_count) AS enrichment_duration_count
       FROM bot_provider_hourly_aggregates
       WHERE bucket_start_ms >= ?
       GROUP BY weekday_utc
       ORDER BY weekday_utc ASC`,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         DAYOFWEEK(FROM_UNIXTIME(bucket_start_ms / 1000)) AS weekday_utc,
         key_type,
         COUNT(DISTINCT key_hash) AS unique_count
       FROM bot_provider_hourly_unique_keys
       WHERE bucket_start_ms >= ?
         AND event_type = 'provider_content'
       GROUP BY weekday_utc, key_type`,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         provider_id,
         DAYOFWEEK(FROM_UNIXTIME(bucket_start_ms / 1000)) AS weekday_utc,
         COUNT(DISTINCT NULLIF(account_key, '')) AS accounts,
         SUM(content_events) AS content_events,
         SUM(analytics_events) AS analytics_events,
         SUM(extract_events) AS extract_events,
         SUM(extract_successes) AS extract_successes,
         SUM(send_events) AS send_events,
         SUM(send_successes) AS send_successes,
         SUM(enrichment_jobs) AS enrichment_jobs,
         SUM(enrichment_successes) AS enrichment_successes,
         SUM(sensitive_events) AS sensitive_events,
         SUM(media_count_sum) AS media_count_sum,
         SUM(duration_seconds_sum) AS duration_seconds_sum,
         SUM(duration_seconds_count) AS duration_seconds_count,
         SUM(analytics_duration_sum_ms) AS analytics_duration_sum_ms,
         SUM(analytics_duration_count) AS analytics_duration_count,
         SUM(enrichment_duration_sum_ms) AS enrichment_duration_sum_ms,
         SUM(enrichment_duration_count) AS enrichment_duration_count
       FROM bot_provider_hourly_aggregates
       WHERE bucket_start_ms >= ?
         AND provider_id <> ''
       GROUP BY provider_id, weekday_utc
       ORDER BY content_events DESC
       LIMIT 160`,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         provider_id,
         DAYOFWEEK(FROM_UNIXTIME(bucket_start_ms / 1000)) AS weekday_utc,
         key_type,
         COUNT(DISTINCT key_hash) AS unique_count
       FROM bot_provider_hourly_unique_keys
       WHERE bucket_start_ms >= ?
         AND event_type = 'provider_content'
         AND provider_id <> ''
       GROUP BY provider_id, weekday_utc, key_type`,
      startMs,
    ),
  ]);

  const hourUniqueMap = new Map<string, Row>();
  for (const row of hourUniqueRows) {
    setAggregateUnique(hourUniqueMap, aggregateSeasonalityKey("hour", row), row.key_type, row.unique_count);
  }

  const weekdayUniqueMap = new Map<string, Row>();
  for (const row of weekdayUniqueRows) {
    setAggregateUnique(weekdayUniqueMap, aggregateSeasonalityKey("weekday", row), row.key_type, row.unique_count);
  }

  const providerWeekdayUniqueMap = new Map<string, Row>();
  for (const row of providerWeekdayUniqueRows) {
    setAggregateUnique(providerWeekdayUniqueMap, aggregateSeasonalityKey("provider_weekday", row), row.key_type, row.unique_count);
  }

  return {
    hours: hourRows.map((row) => decorateAggregateSeasonalityRow(row, hourUniqueMap.get(aggregateSeasonalityKey("hour", row)) || {})),
    weekdays: weekdayRows.map((row) => decorateAggregateSeasonalityRow(row, weekdayUniqueMap.get(aggregateSeasonalityKey("weekday", row)) || {})),
    providerWeekdays: providerWeekdayRows.map((row) =>
      decorateAggregateSeasonalityRow(row, providerWeekdayUniqueMap.get(aggregateSeasonalityKey("provider_weekday", row)) || {}),
    ),
  };
}

async function getAggregateEventDaySpikes(startMs: number) {
  const [dailyRows, dailyUniqueRows, providerDailyRows, providerDailyUniqueRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         FLOOR(bucket_start_ms / ?) * ? AS day_start_ms,
         COUNT(*) AS aggregate_rows,
         COUNT(DISTINCT NULLIF(provider_id, '')) AS providers,
         COUNT(DISTINCT NULLIF(account_key, '')) AS accounts,
         SUM(content_events) AS content_events,
         SUM(analytics_events) AS analytics_events,
         SUM(extract_events) AS extract_events,
         SUM(extract_successes) AS extract_successes,
         SUM(send_events) AS send_events,
         SUM(send_successes) AS send_successes,
         SUM(enrichment_jobs) AS enrichment_jobs,
         SUM(enrichment_successes) AS enrichment_successes,
         SUM(sensitive_events) AS sensitive_events,
         SUM(media_count_sum) AS media_count_sum,
         SUM(duration_seconds_sum) AS duration_seconds_sum,
         SUM(duration_seconds_count) AS duration_seconds_count,
         SUM(analytics_duration_sum_ms) AS analytics_duration_sum_ms,
         SUM(analytics_duration_count) AS analytics_duration_count,
         SUM(enrichment_duration_sum_ms) AS enrichment_duration_sum_ms,
         SUM(enrichment_duration_count) AS enrichment_duration_count
       FROM bot_provider_hourly_aggregates
       WHERE bucket_start_ms >= ?
       GROUP BY day_start_ms
       ORDER BY day_start_ms DESC
       LIMIT 45`,
      DAY_MS,
      DAY_MS,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         FLOOR(bucket_start_ms / ?) * ? AS day_start_ms,
         key_type,
         COUNT(DISTINCT key_hash) AS unique_count
       FROM bot_provider_hourly_unique_keys
       WHERE bucket_start_ms >= ?
         AND event_type = 'provider_content'
       GROUP BY day_start_ms, key_type`,
      DAY_MS,
      DAY_MS,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         provider_id,
         FLOOR(bucket_start_ms / ?) * ? AS day_start_ms,
         COUNT(DISTINCT NULLIF(account_key, '')) AS accounts,
         SUM(content_events) AS content_events,
         SUM(analytics_events) AS analytics_events,
         SUM(extract_events) AS extract_events,
         SUM(extract_successes) AS extract_successes,
         SUM(send_events) AS send_events,
         SUM(send_successes) AS send_successes,
         SUM(enrichment_jobs) AS enrichment_jobs,
         SUM(enrichment_successes) AS enrichment_successes,
         SUM(sensitive_events) AS sensitive_events,
         SUM(media_count_sum) AS media_count_sum,
         SUM(duration_seconds_sum) AS duration_seconds_sum,
         SUM(duration_seconds_count) AS duration_seconds_count,
         SUM(analytics_duration_sum_ms) AS analytics_duration_sum_ms,
         SUM(analytics_duration_count) AS analytics_duration_count,
         SUM(enrichment_duration_sum_ms) AS enrichment_duration_sum_ms,
         SUM(enrichment_duration_count) AS enrichment_duration_count
       FROM bot_provider_hourly_aggregates
       WHERE bucket_start_ms >= ?
         AND provider_id <> ''
       GROUP BY provider_id, day_start_ms
       HAVING content_events > 0
       ORDER BY content_events DESC
       LIMIT 240`,
      DAY_MS,
      DAY_MS,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         provider_id,
         FLOOR(bucket_start_ms / ?) * ? AS day_start_ms,
         key_type,
         COUNT(DISTINCT key_hash) AS unique_count
       FROM bot_provider_hourly_unique_keys
       WHERE bucket_start_ms >= ?
         AND event_type = 'provider_content'
         AND provider_id <> ''
       GROUP BY provider_id, day_start_ms, key_type`,
      DAY_MS,
      DAY_MS,
      startMs,
    ),
  ]);

  const dailyUniqueMap = new Map<string, Row>();
  for (const row of dailyUniqueRows) {
    setAggregateUnique(dailyUniqueMap, aggregateDayKey(row), row.key_type, row.unique_count);
  }

  const providerDailyUniqueMap = new Map<string, Row>();
  for (const row of providerDailyUniqueRows) {
    setAggregateUnique(providerDailyUniqueMap, aggregateDayKey(row), row.key_type, row.unique_count);
  }

  const providerSums = new Map<string, { total: number; days: number }>();
  for (const row of providerDailyRows) {
    const key = String(row.provider_id || "");
    const current = providerSums.get(key) || { total: 0, days: 0 };
    current.total += rowNumber(row, "content_events");
    current.days += 1;
    providerSums.set(key, current);
  }
  const providerBaselines = new Map<string, number>();
  for (const [provider, value] of providerSums.entries()) {
    providerBaselines.set(provider, rate(value.total, Math.max(1, value.days)));
  }

  return {
    days: protectSmallGroupRows(decorateEventDaySpikeRows(dailyRows, dailyUniqueMap).slice(0, 45)),
    providers: protectSmallGroupRows(decorateEventDaySpikeRows(providerDailyRows, providerDailyUniqueMap, providerBaselines).slice(0, 120)),
  };
}

async function getAggregateAudienceCorrelation(startMs: number) {
  const [pairRows, targetTotals, interestTotals, totalRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         target.provider_id AS target_provider_id,
         target.account_key AS target_account_key,
         other.provider_id AS interest_provider_id,
         other.account_key AS interest_account_key,
         other.content_type AS interest_content_type,
         COUNT(DISTINCT target.key_hash) AS shared_users
       FROM (
         SELECT DISTINCT provider_id, account_key, key_hash
         FROM bot_provider_hourly_unique_keys
         WHERE bucket_start_ms >= ?
           AND event_type = 'provider_content'
           AND key_type = 'author_user'
           AND provider_id <> ''
           AND account_key <> ''
       ) target
       JOIN (
         SELECT DISTINCT provider_id, account_key, content_type, key_hash
         FROM bot_provider_hourly_unique_keys
         WHERE bucket_start_ms >= ?
           AND event_type = 'provider_content'
           AND key_type = 'author_user'
           AND provider_id <> ''
           AND account_key <> ''
       ) other
         ON other.key_hash = target.key_hash
        AND (
          other.provider_id <> target.provider_id
          OR other.account_key <> target.account_key
        )
       GROUP BY target.provider_id, target.account_key, other.provider_id, other.account_key, other.content_type
       ORDER BY shared_users DESC
       LIMIT 160`,
      startMs,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         provider_id,
         account_key,
         COUNT(DISTINCT key_hash) AS target_users
       FROM bot_provider_hourly_unique_keys
       WHERE bucket_start_ms >= ?
         AND event_type = 'provider_content'
         AND key_type = 'author_user'
         AND provider_id <> ''
         AND account_key <> ''
       GROUP BY provider_id, account_key`,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         provider_id,
         account_key,
         content_type,
         COUNT(DISTINCT key_hash) AS interest_users
       FROM bot_provider_hourly_unique_keys
       WHERE bucket_start_ms >= ?
         AND event_type = 'provider_content'
         AND key_type = 'author_user'
         AND provider_id <> ''
         AND account_key <> ''
       GROUP BY provider_id, account_key, content_type`,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT COUNT(DISTINCT key_hash) AS total_users
       FROM bot_provider_hourly_unique_keys
       WHERE bucket_start_ms >= ?
         AND event_type = 'provider_content'
         AND key_type = 'author_user'`,
      startMs,
    ),
  ]);

  const targetMap = new Map<string, Row>();
  for (const row of targetTotals) {
    targetMap.set(aggregateUniqueKey(row.provider_id, row.account_key), row);
  }

  const interestMap = new Map<string, Row>();
  for (const row of interestTotals) {
    interestMap.set(aggregateUniqueKey(row.provider_id, row.account_key, "", row.content_type), row);
  }

  const totalUsers = rowNumber(totalRows[0] || {}, "total_users");
  const rows = pairRows.map((row) => {
    const targetUsers = rowNumber(targetMap.get(aggregateUniqueKey(row.target_provider_id, row.target_account_key)) || {}, "target_users");
    const interestUsers = rowNumber(
      interestMap.get(aggregateUniqueKey(row.interest_provider_id, row.interest_account_key, "", row.interest_content_type)) || {},
      "interest_users",
    );
    const sharedUsers = rowNumber(row, "shared_users");
    const targetShare = rate(sharedUsers, targetUsers);
    const baselineShare = rate(interestUsers, totalUsers);
    const lift = baselineShare > 0 ? targetShare / baselineShare : 0;
    return {
      ...maskRow(row),
      target_users: targetUsers,
      interest_users: interestUsers,
      total_users: totalUsers,
      target_share: targetShare,
      baseline_share: baselineShare,
      lift,
      affinity_score: sharedUsers * lift,
      analysis_model: "audience_correlation",
      data_source: "bot_provider_hourly_unique_keys",
    };
  });

  return protectSmallGroupRows(rows);
}

async function getSettingAdoption() {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       provider_id,
       COUNT(*) AS configured_guilds,
       SUM(enabled = 1) AS enabled_guilds,
       SUM(enabled = 0) AS disabled_guilds,
       SUM(hidden_output_items IS NOT NULL AND hidden_output_items <> '') AS customized_output_visibility,
       SUM(media_display_mode IS NOT NULL) AS customized_media_display,
       SUM(failure_display_policy IS NOT NULL) AS customized_failure_policy
     FROM guild_provider_settings
     GROUP BY provider_id
     ORDER BY configured_guilds DESC, provider_id ASC
     LIMIT 30`,
  );
  return rows.map((row) => ({
    ...maskRow(row),
    enabled_rate: rate(row.enabled_guilds, row.configured_guilds),
  }));
}

async function getAutoExtractAnalytics() {
  const [summary, topUsers, topAccounts] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         COUNT(*) AS total_targets,
         SUM(enabled = 1) AS enabled_targets,
         SUM(enabled = 0) AS disabled_targets,
         SUM(premium_slot = 1) AS premium_targets,
         COUNT(DISTINCT user_id) AS unique_users,
         COUNT(DISTINCT twitter_username) AS unique_accounts
       FROM auto_extract_targets`,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT user_id, COUNT(*) AS targets, SUM(enabled = 1) AS enabled_targets
       FROM auto_extract_targets
       GROUP BY user_id
       ORDER BY targets DESC
       LIMIT 20`,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT twitter_username, COUNT(*) AS watchers, SUM(enabled = 1) AS enabled_watchers
       FROM auto_extract_targets
       GROUP BY twitter_username
       ORDER BY watchers DESC
       LIMIT 20`,
    ),
  ]);
  return {
    summary: maskRow(summary[0] || {}),
    topUsers: topUsers.map(maskRow),
    topAccounts: topAccounts.map(maskRow),
  };
}

async function getCommandUsageAnalytics(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       command_name,
       COUNT(*) AS executions,
       SUM(success = 1) AS successes,
       SUM(success = 0) AS failures,
       COUNT(DISTINCT author_user_id) AS unique_users,
       COUNT(DISTINCT guild_id) AS unique_guilds,
       AVG(duration_ms) AS avg_duration_ms,
       MAX(duration_ms) AS max_duration_ms
     FROM bot_analytics_events
     WHERE occurred_at_ms >= ?
       AND event_type = 'command'
       AND command_name IS NOT NULL
     GROUP BY command_name
     ORDER BY executions DESC
     LIMIT 50`,
    startMs,
  );
  return rows.map((row) => ({
    ...maskRow(row),
    success_rate: rate(row.successes, Number(row.successes || 0) + Number(row.failures || 0)),
  }));
}

async function getUserUsageAnalytics(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       author_user_id,
       COUNT(*) AS events,
       SUM(event_type = 'command') AS command_events,
       SUM(event_type = 'provider_extract') AS provider_events,
       SUM(event_type = 'component') AS component_events,
       COUNT(DISTINCT guild_id) AS unique_guilds,
       COUNT(DISTINCT provider_id) AS unique_providers,
       COUNT(DISTINCT account_key) AS unique_accounts,
       AVG(duration_ms) AS avg_duration_ms
     FROM bot_analytics_events
     WHERE occurred_at_ms >= ?
       AND author_user_id IS NOT NULL
     GROUP BY author_user_id
     ORDER BY events DESC
     LIMIT 50`,
    startMs,
  );
  return rows.map(maskRow);
}

async function getProviderAccountSummary(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       provider_id,
       account_key,
       COUNT(*) AS content_events,
       COUNT(DISTINCT author_user_id) AS unique_users,
       COUNT(DISTINCT guild_id) AS unique_guilds,
       COUNT(DISTINCT normalized_url) AS unique_urls,
       AVG(media_count) AS avg_media_count,
       AVG(duration_seconds) AS avg_duration_seconds,
       SUM(\`sensitive\` = 1) AS sensitive_events,
       MAX(occurred_at_ms) AS last_seen_ms
     FROM bot_provider_content_events
     WHERE occurred_at_ms >= ?
       AND provider_id IS NOT NULL
       AND account_key IS NOT NULL
     GROUP BY provider_id, account_key
     ORDER BY content_events DESC
     LIMIT 80`,
    startMs,
  );
  return rows.map((row) => ({
    ...maskRow(row),
    sensitive_rate: rate(row.sensitive_events, row.content_events),
  }));
}

async function getFunnelAnalytics(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       provider_id,
       account_key,
       SUM(event_type = 'provider_extract') AS url_posts,
       SUM(event_type = 'provider_extract' AND success = 1) AS extract_successes,
       SUM(event_type = 'provider_extract' AND success = 0) AS extract_failures,
       SUM(event_type = 'discord_send') AS send_attempts,
       SUM(event_type = 'discord_send' AND success = 1) AS send_successes,
       SUM(event_type = 'discord_send' AND success = 0) AS send_failures,
       SUM(event_type IN ('component', 'modal_submit')) AS interaction_events,
       SUM(event_type = 'media_delivery') AS media_delivery_requests,
       SUM(event_type = 'media_delivery' AND success = 1) AS media_delivery_successes,
       SUM(event_type = 'media_delivery' AND success = 0) AS media_delivery_failures,
       COUNT(DISTINCT guild_id) AS guilds,
       COUNT(DISTINCT author_user_id) AS users
     FROM bot_analytics_events
     WHERE occurred_at_ms >= ?
       AND provider_id IS NOT NULL
     GROUP BY provider_id, account_key
     ORDER BY url_posts DESC, interaction_events DESC
     LIMIT 100`,
    startMs,
  );
  return protectSmallGroupRows(rows.map((row) => ({
    ...maskRow(row),
    extract_success_rate: rate(row.extract_successes, row.url_posts),
    send_success_rate: rate(row.send_successes, row.send_attempts),
    interaction_rate: rate(row.interaction_events, row.send_successes),
    media_delivery_rate: rate(row.media_delivery_successes, row.send_successes),
  })));
}

async function getMediaDeliveryAnalytics(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       provider_id,
       account_key,
       endpoint_key,
       COUNT(*) AS requests,
       SUM(success = 1) AS successes,
       SUM(success = 0) AS failures,
       COUNT(DISTINCT url_hash) AS urls,
       AVG(duration_ms) AS avg_duration_ms,
       MAX(duration_ms) AS max_duration_ms
     FROM bot_analytics_events
     WHERE occurred_at_ms >= ?
       AND event_type = 'media_delivery'
       AND provider_id IS NOT NULL
     GROUP BY provider_id, account_key, endpoint_key
     ORDER BY requests DESC
     LIMIT 80`,
    startMs,
  );
  return rows.map((row) => ({
    ...maskRow(row),
    success_rate: rate(row.successes, Number(row.successes || 0) + Number(row.failures || 0)),
  }));
}

async function getSettingChangeImpact(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       a.audit_log_id,
       a.guild_id,
       a.provider_id,
       a.setting_key,
       a.action,
       UNIX_TIMESTAMP(a.created_at) * 1000 AS changed_at_ms,
       (
         SELECT COUNT(*)
         FROM bot_provider_content_events c
         WHERE c.occurred_at_ms >= (UNIX_TIMESTAMP(a.created_at) * 1000) - ?
           AND c.occurred_at_ms < UNIX_TIMESTAMP(a.created_at) * 1000
           AND (a.guild_id IS NULL OR c.guild_id = a.guild_id)
           AND (a.provider_id IS NULL OR c.provider_id = a.provider_id)
       ) AS content_before,
       (
         SELECT COUNT(*)
         FROM bot_provider_content_events c
         WHERE c.occurred_at_ms >= UNIX_TIMESTAMP(a.created_at) * 1000
           AND c.occurred_at_ms < (UNIX_TIMESTAMP(a.created_at) * 1000) + ?
           AND (a.guild_id IS NULL OR c.guild_id = a.guild_id)
           AND (a.provider_id IS NULL OR c.provider_id = a.provider_id)
       ) AS content_after,
       (
         SELECT COUNT(DISTINCT c.author_user_id)
         FROM bot_provider_content_events c
         WHERE c.occurred_at_ms >= UNIX_TIMESTAMP(a.created_at) * 1000
           AND c.occurred_at_ms < (UNIX_TIMESTAMP(a.created_at) * 1000) + ?
           AND (a.guild_id IS NULL OR c.guild_id = a.guild_id)
           AND (a.provider_id IS NULL OR c.provider_id = a.provider_id)
       ) AS users_after
     FROM dashboard_audit_logs a
     WHERE a.created_at >= ?
       AND (a.provider_id IS NOT NULL OR a.guild_id IS NOT NULL)
     ORDER BY a.created_at DESC
     LIMIT 60`,
    7 * DAY_MS,
    7 * DAY_MS,
    7 * DAY_MS,
    new Date(startMs),
  );
  return protectSmallGroupRows(rows.map((row) => ({
    ...maskRow(row),
    absolute_change: Number(row.content_after || 0) - Number(row.content_before || 0),
    change_rate: rate(Number(row.content_after || 0) - Number(row.content_before || 0), row.content_before),
  })), ["audit_log_id"]);
}

function settingAttributionAuditScopeSql() {
  return `SELECT
    audit_log_id,
    guild_id,
    provider_id,
    COALESCE(setting_key, '__provider__') AS setting_key,
    action,
    UNIX_TIMESTAMP(created_at) * 1000 AS changed_at_ms,
    CASE
      WHEN setting_key = 'enabled' THEN 'provider_enabled'
      WHEN action = 'provider.reset' THEN 'provider_reset'
      WHEN setting_key IS NULL THEN action
      ELSE CONCAT('setting:', setting_key)
    END AS attribution_type,
    CASE
      WHEN setting_key = 'enabled' AND after_json IN ('true', '1', '"true"') THEN 'enabled'
      WHEN setting_key = 'enabled' AND after_json IN ('false', '0', '"false"') THEN 'disabled'
      WHEN action = 'provider.reset' THEN 'reset'
      ELSE 'changed'
    END AS setting_direction
  FROM dashboard_audit_logs
  WHERE created_at >= ?
    AND (provider_id IS NOT NULL OR guild_id IS NOT NULL)`;
}

async function getSettingAttributionSummary(startMs: number) {
  const windowMs = 7 * DAY_MS;
  const auditScope = settingAttributionAuditScopeSql();
  const [impactRows, uniqueRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         a.attribution_type,
         a.setting_direction,
         a.provider_id,
         a.setting_key,
         a.action,
         COUNT(DISTINCT a.audit_log_id) AS changes,
         COUNT(DISTINCT a.guild_id) AS affected_guilds,
         SUM(CASE WHEN h.bucket_start_ms < a.changed_at_ms THEN h.content_events ELSE 0 END) AS content_before,
         SUM(CASE WHEN h.bucket_start_ms >= a.changed_at_ms THEN h.content_events ELSE 0 END) AS content_after,
         SUM(CASE WHEN h.bucket_start_ms < a.changed_at_ms THEN h.extract_events ELSE 0 END) AS extract_before,
         SUM(CASE WHEN h.bucket_start_ms >= a.changed_at_ms THEN h.extract_events ELSE 0 END) AS extract_after,
         SUM(CASE WHEN h.bucket_start_ms < a.changed_at_ms THEN h.extract_successes ELSE 0 END) AS extract_successes_before,
         SUM(CASE WHEN h.bucket_start_ms >= a.changed_at_ms THEN h.extract_successes ELSE 0 END) AS extract_successes_after,
         SUM(CASE WHEN h.bucket_start_ms < a.changed_at_ms THEN h.send_events ELSE 0 END) AS send_before,
         SUM(CASE WHEN h.bucket_start_ms >= a.changed_at_ms THEN h.send_events ELSE 0 END) AS send_after,
         SUM(CASE WHEN h.bucket_start_ms < a.changed_at_ms THEN h.send_successes ELSE 0 END) AS send_successes_before,
         SUM(CASE WHEN h.bucket_start_ms >= a.changed_at_ms THEN h.send_successes ELSE 0 END) AS send_successes_after,
         SUM(CASE WHEN h.bucket_start_ms < a.changed_at_ms THEN h.enrichment_jobs ELSE 0 END) AS enrichment_before,
         SUM(CASE WHEN h.bucket_start_ms >= a.changed_at_ms THEN h.enrichment_jobs ELSE 0 END) AS enrichment_after,
         SUM(CASE WHEN h.bucket_start_ms < a.changed_at_ms THEN h.enrichment_successes ELSE 0 END) AS enrichment_successes_before,
         SUM(CASE WHEN h.bucket_start_ms >= a.changed_at_ms THEN h.enrichment_successes ELSE 0 END) AS enrichment_successes_after,
         SUM(CASE WHEN h.bucket_start_ms < a.changed_at_ms THEN h.analytics_duration_sum_ms ELSE 0 END) AS analytics_duration_sum_before,
         SUM(CASE WHEN h.bucket_start_ms >= a.changed_at_ms THEN h.analytics_duration_sum_ms ELSE 0 END) AS analytics_duration_sum_after,
         SUM(CASE WHEN h.bucket_start_ms < a.changed_at_ms THEN h.analytics_duration_count ELSE 0 END) AS analytics_duration_count_before,
         SUM(CASE WHEN h.bucket_start_ms >= a.changed_at_ms THEN h.analytics_duration_count ELSE 0 END) AS analytics_duration_count_after,
         MAX(h.bucket_start_ms) AS latest_bucket_ms
       FROM (${auditScope}) a
       LEFT JOIN bot_provider_hourly_aggregates h
         ON h.bucket_start_ms >= a.changed_at_ms - ?
        AND h.bucket_start_ms < a.changed_at_ms + ?
        AND (a.guild_id IS NULL OR h.guild_id = a.guild_id)
        AND (a.provider_id IS NULL OR h.provider_id = a.provider_id)
       GROUP BY a.attribution_type, a.setting_direction, a.provider_id, a.setting_key, a.action
       ORDER BY content_after DESC, changes DESC
       LIMIT 120`,
      new Date(startMs),
      windowMs,
      windowMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         a.attribution_type,
         a.setting_direction,
         a.provider_id,
         a.setting_key,
         a.action,
         u.key_type,
         COUNT(DISTINCT u.key_hash) AS unique_count
       FROM (${auditScope}) a
       JOIN bot_provider_hourly_unique_keys u
         ON u.bucket_start_ms >= a.changed_at_ms
        AND u.bucket_start_ms < a.changed_at_ms + ?
        AND u.event_type = 'provider_content'
        AND (a.guild_id IS NULL OR u.guild_id = a.guild_id)
        AND (a.provider_id IS NULL OR u.provider_id = a.provider_id)
        AND u.key_type IN ('author_user', 'guild', 'url')
       GROUP BY a.attribution_type, a.setting_direction, a.provider_id, a.setting_key, a.action, u.key_type`,
      new Date(startMs),
      windowMs,
    ),
  ]);

  const uniqueMap = new Map<string, Row>();
  for (const row of uniqueRows) {
    const key = [row.attribution_type || "", row.setting_direction || "", row.provider_id || "", row.setting_key || "", row.action || ""].join("\u0001");
    setAggregateUnique(uniqueMap, key, row.key_type, row.unique_count);
  }

  const rows = impactRows.map((row) => {
    const key = [row.attribution_type || "", row.setting_direction || "", row.provider_id || "", row.setting_key || "", row.action || ""].join("\u0001");
    const contentBefore = rowNumber(row, "content_before");
    const contentAfter = rowNumber(row, "content_after");
    return {
      ...maskRow(row),
      ...(uniqueMap.get(key) || {}),
      absolute_change: contentAfter - contentBefore,
      change_rate: rate(contentAfter - contentBefore, contentBefore),
      extract_success_rate_before: rate(row.extract_successes_before, row.extract_before),
      extract_success_rate_after: rate(row.extract_successes_after, row.extract_after),
      send_success_rate_before: rate(row.send_successes_before, row.send_before),
      send_success_rate_after: rate(row.send_successes_after, row.send_after),
      enrichment_success_rate_before: rate(row.enrichment_successes_before, row.enrichment_before),
      enrichment_success_rate_after: rate(row.enrichment_successes_after, row.enrichment_after),
      avg_analytics_duration_before_ms: rate(row.analytics_duration_sum_before, row.analytics_duration_count_before),
      avg_analytics_duration_after_ms: rate(row.analytics_duration_sum_after, row.analytics_duration_count_after),
      attribution_window_days: 7,
      analysis_model: "setting_attribution_summary",
      data_source: "bot_provider_hourly_aggregates",
      unique_data_source: "bot_provider_hourly_unique_keys",
    };
  });

  return protectSmallGroupRows(rows);
}

async function getWeeklyCohortAnalytics(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       cohorts.cohort_week_ms,
       activity.activity_week_ms,
       COUNT(DISTINCT activity.author_user_id) AS retained_users,
       cohort_sizes.cohort_users
     FROM (
       SELECT
         author_user_id,
         FLOOR(MIN(occurred_at_ms) / ?) * ? AS cohort_week_ms
       FROM bot_provider_content_events
       WHERE author_user_id IS NOT NULL
       GROUP BY author_user_id
     ) cohorts
     JOIN (
       SELECT cohort_week_ms, COUNT(*) AS cohort_users
       FROM (
         SELECT
           author_user_id,
           FLOOR(MIN(occurred_at_ms) / ?) * ? AS cohort_week_ms
         FROM bot_provider_content_events
         WHERE author_user_id IS NOT NULL
         GROUP BY author_user_id
       ) first_seen
       GROUP BY cohort_week_ms
     ) cohort_sizes ON cohort_sizes.cohort_week_ms = cohorts.cohort_week_ms
     JOIN (
       SELECT
         author_user_id,
         FLOOR(occurred_at_ms / ?) * ? AS activity_week_ms
       FROM bot_provider_content_events
       WHERE occurred_at_ms >= ?
         AND author_user_id IS NOT NULL
       GROUP BY author_user_id, activity_week_ms
     ) activity ON activity.author_user_id = cohorts.author_user_id
     WHERE cohorts.cohort_week_ms >= ?
     GROUP BY cohorts.cohort_week_ms, activity.activity_week_ms, cohort_sizes.cohort_users
     ORDER BY cohorts.cohort_week_ms DESC, activity.activity_week_ms ASC
     LIMIT 120`,
    7 * DAY_MS,
    7 * DAY_MS,
    7 * DAY_MS,
    7 * DAY_MS,
    7 * DAY_MS,
    7 * DAY_MS,
    startMs,
    startMs - 8 * 7 * DAY_MS,
  );
  return protectSmallGroupRows(rows.map((row) => ({
    ...maskRow(row),
    age_weeks: Math.max(0, Math.round((Number(row.activity_week_ms || 0) - Number(row.cohort_week_ms || 0)) / (7 * DAY_MS))),
    retention_rate: rate(row.retained_users, row.cohort_users),
  })));
}

async function getContentLifetimeAnalytics(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       provider_id,
       account_key,
       content_type,
       content_url,
       normalized_url,
       MAX(title) AS title,
       COUNT(*) AS content_events,
       COUNT(DISTINCT author_user_id) AS users,
       COUNT(DISTINCT guild_id) AS guilds,
       MIN(occurred_at_ms) AS first_seen_ms,
       MAX(occurred_at_ms) AS last_seen_ms
     FROM bot_provider_content_events
     WHERE occurred_at_ms >= ?
       AND (content_url IS NOT NULL OR normalized_url IS NOT NULL)
     GROUP BY provider_id, account_key, content_type, content_url, normalized_url
     HAVING content_events > 1 OR guilds > 1
     ORDER BY (last_seen_ms - first_seen_ms) DESC, content_events DESC
     LIMIT 100`,
    startMs,
  );
  return protectSmallGroupRows(rows.map((row) => ({
    ...maskRow(row),
    lifetime_hours: rate(Number(row.last_seen_ms || 0) - Number(row.first_seen_ms || 0), HOUR_MS),
  })));
}

async function getUrlReuseAnalytics(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       provider_id,
       account_key,
       content_url,
       normalized_url,
       MAX(title) AS title,
       COUNT(*) AS content_events,
       COUNT(DISTINCT guild_id) AS guilds,
       COUNT(DISTINCT author_user_id) AS users,
       MIN(occurred_at_ms) AS first_seen_ms,
       MAX(occurred_at_ms) AS last_seen_ms
     FROM bot_provider_content_events
     WHERE occurred_at_ms >= ?
       AND (content_url IS NOT NULL OR normalized_url IS NOT NULL)
     GROUP BY provider_id, account_key, content_url, normalized_url
     HAVING guilds > 1
     ORDER BY guilds DESC, content_events DESC
     LIMIT 100`,
    startMs,
  );
  return protectSmallGroupRows(rows.map((row) => ({
    ...maskRow(row),
    spread_velocity_per_day: rate(row.guilds, Math.max(1, rate(Number(row.last_seen_ms || 0) - Number(row.first_seen_ms || 0), DAY_MS))),
  })));
}

async function getProviderAccountHealth(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       content.provider_id,
       content.account_key,
       content.content_events,
       content.unique_users,
       content.unique_guilds,
       content.unique_urls,
       content.last_seen_ms,
       COALESCE(reliability.extract_events, 0) AS extract_events,
       COALESCE(reliability.extract_successes, 0) AS extract_successes,
       COALESCE(reliability.extract_failures, 0) AS extract_failures,
       COALESCE(reliability.enrichment_jobs, 0) AS enrichment_jobs,
       COALESCE(reliability.enrichment_successes, 0) AS enrichment_successes,
       COALESCE(reliability.enrichment_failures, 0) AS enrichment_failures,
       COALESCE(reliability.avg_extract_duration_ms, 0) AS avg_extract_duration_ms,
       COALESCE(reliability.avg_enrichment_duration_ms, 0) AS avg_enrichment_duration_ms,
       COALESCE(errors.error_events, 0) AS error_events
     FROM (
       SELECT
         provider_id,
         account_key,
         COUNT(*) AS content_events,
         COUNT(DISTINCT author_user_id) AS unique_users,
         COUNT(DISTINCT guild_id) AS unique_guilds,
         COUNT(DISTINCT normalized_url) AS unique_urls,
         MAX(occurred_at_ms) AS last_seen_ms
       FROM bot_provider_content_events
       WHERE occurred_at_ms >= ?
         AND provider_id IS NOT NULL
         AND account_key IS NOT NULL
       GROUP BY provider_id, account_key
     ) content
     LEFT JOIN (
       SELECT
         provider_id,
         account_key,
         SUM(event_type = 'provider_extract') AS extract_events,
         SUM(event_type = 'provider_extract' AND success = 1) AS extract_successes,
         SUM(event_type = 'provider_extract' AND success = 0) AS extract_failures,
         SUM(event_type = 'provider_analytics_enrichment') AS enrichment_jobs,
         SUM(event_type = 'provider_analytics_enrichment' AND success = 1) AS enrichment_successes,
         SUM(event_type = 'provider_analytics_enrichment' AND success = 0) AS enrichment_failures,
         AVG(CASE WHEN event_type = 'provider_extract' THEN duration_ms ELSE NULL END) AS avg_extract_duration_ms,
         AVG(CASE WHEN event_type = 'provider_analytics_enrichment' THEN duration_ms ELSE NULL END) AS avg_enrichment_duration_ms
       FROM bot_analytics_events
       WHERE occurred_at_ms >= ?
       GROUP BY provider_id, account_key
     ) reliability ON reliability.provider_id = content.provider_id AND COALESCE(reliability.account_key, '') = COALESCE(content.account_key, '')
     LEFT JOIN (
       SELECT provider_id, COUNT(*) AS error_events
       FROM bot_error_events
       WHERE occurred_at_ms >= ?
       GROUP BY provider_id
     ) errors ON errors.provider_id = content.provider_id
     ORDER BY content.content_events DESC
     LIMIT 100`,
    startMs,
    startMs,
    startMs,
  );
  return protectSmallGroupRows(rows.map((row) => {
    const extractSuccessRate = rate(row.extract_successes, Number(row.extract_successes || 0) + Number(row.extract_failures || 0));
    const enrichmentSuccessRate = Number(row.enrichment_jobs || 0) > 0
      ? rate(row.enrichment_successes, Number(row.enrichment_successes || 0) + Number(row.enrichment_failures || 0))
      : 1;
    const popularity = clamp01(Math.log10(Number(row.content_events || 0) + 1) / 3);
    const reach = clamp01(Math.log10(Number(row.unique_guilds || 0) + 1) / 2);
    const reliability = clamp01((extractSuccessRate * 0.7) + (enrichmentSuccessRate * 0.3));
    const errorPenalty = clamp01(rate(row.error_events, Number(row.extract_events || 0) + Number(row.content_events || 0)));
    const freshness = clamp01(1 - rate(Date.now() - Number(row.last_seen_ms || 0), 30 * DAY_MS));
    const healthScore = Math.round(100 * clamp01((popularity * 0.25) + (reach * 0.2) + (reliability * 0.35) + (freshness * 0.2) - (errorPenalty * 0.3)));
    return {
      ...maskRow(row),
      extract_success_rate: extractSuccessRate,
      enrichment_success_rate: enrichmentSuccessRate,
      error_rate: errorPenalty,
      freshness_score: freshness,
      health_score: healthScore,
    };
  }));
}

async function getProviderAnomalySignals(now: number) {
  const currentStart = now - HOUR_MS;
  const baselineStart = now - 25 * HOUR_MS;
  const baselineEnd = now - HOUR_MS;
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       cur.provider_id,
       cur.extract_events AS current_extract_events,
       cur.extract_successes AS current_extract_successes,
       cur.extract_failures AS current_extract_failures,
       cur.avg_extract_duration_ms AS current_avg_extract_duration_ms,
       cur.enrichment_jobs AS current_enrichment_jobs,
       cur.enrichment_failures AS current_enrichment_failures,
       cur.media_delivery_requests AS current_media_delivery_requests,
       cur.media_delivery_failures AS current_media_delivery_failures,
       COALESCE(baseline.extract_events, 0) AS baseline_extract_events,
       COALESCE(baseline.extract_successes, 0) AS baseline_extract_successes,
       COALESCE(baseline.extract_failures, 0) AS baseline_extract_failures,
       COALESCE(baseline.avg_extract_duration_ms, 0) AS baseline_avg_extract_duration_ms,
       COALESCE(baseline.enrichment_jobs, 0) AS baseline_enrichment_jobs,
       COALESCE(baseline.enrichment_failures, 0) AS baseline_enrichment_failures,
       COALESCE(baseline.media_delivery_requests, 0) AS baseline_media_delivery_requests,
       COALESCE(baseline.media_delivery_failures, 0) AS baseline_media_delivery_failures
     FROM (
       SELECT
         provider_id,
         SUM(event_type = 'provider_extract') AS extract_events,
         SUM(event_type = 'provider_extract' AND success = 1) AS extract_successes,
         SUM(event_type = 'provider_extract' AND success = 0) AS extract_failures,
         AVG(CASE WHEN event_type = 'provider_extract' THEN duration_ms ELSE NULL END) AS avg_extract_duration_ms,
         SUM(event_type = 'provider_analytics_enrichment') AS enrichment_jobs,
         SUM(event_type = 'provider_analytics_enrichment' AND success = 0) AS enrichment_failures,
         SUM(event_type = 'media_delivery') AS media_delivery_requests,
         SUM(event_type = 'media_delivery' AND success = 0) AS media_delivery_failures
       FROM bot_analytics_events
       WHERE occurred_at_ms >= ?
         AND occurred_at_ms <= ?
         AND provider_id IS NOT NULL
         AND event_type IN ('provider_extract', 'provider_analytics_enrichment', 'media_delivery')
       GROUP BY provider_id
     ) cur
     LEFT JOIN (
       SELECT
         provider_id,
         SUM(event_type = 'provider_extract') AS extract_events,
         SUM(event_type = 'provider_extract' AND success = 1) AS extract_successes,
         SUM(event_type = 'provider_extract' AND success = 0) AS extract_failures,
         AVG(CASE WHEN event_type = 'provider_extract' THEN duration_ms ELSE NULL END) AS avg_extract_duration_ms,
         SUM(event_type = 'provider_analytics_enrichment') AS enrichment_jobs,
         SUM(event_type = 'provider_analytics_enrichment' AND success = 0) AS enrichment_failures,
         SUM(event_type = 'media_delivery') AS media_delivery_requests,
         SUM(event_type = 'media_delivery' AND success = 0) AS media_delivery_failures
       FROM bot_analytics_events
       WHERE occurred_at_ms >= ?
         AND occurred_at_ms < ?
         AND provider_id IS NOT NULL
         AND event_type IN ('provider_extract', 'provider_analytics_enrichment', 'media_delivery')
       GROUP BY provider_id
     ) baseline ON baseline.provider_id = cur.provider_id
     ORDER BY cur.extract_events DESC, cur.enrichment_jobs DESC
     LIMIT 120`,
    currentStart,
    now,
    baselineStart,
    baselineEnd,
  );

  const alerts: Row[] = [];
  for (const row of rows) {
    const currentExtractEvents = Number(row.current_extract_events || 0);
    const baselineExtractEvents = Number(row.baseline_extract_events || 0);
    const currentExtractSuccessRate = rate(row.current_extract_successes, currentExtractEvents);
    const baselineExtractSuccessRate = rate(row.baseline_extract_successes, baselineExtractEvents);
    const currentExtractErrorRate = rate(row.current_extract_failures, currentExtractEvents);
    const baselineExtractErrorRate = rate(row.baseline_extract_failures, baselineExtractEvents);
    const currentDuration = Number(row.current_avg_extract_duration_ms || 0);
    const baselineDuration = Number(row.baseline_avg_extract_duration_ms || 0);
    const currentEnrichmentJobs = Number(row.current_enrichment_jobs || 0);
    const baselineEnrichmentJobs = Number(row.baseline_enrichment_jobs || 0);
    const currentEnrichmentFailureRate = rate(row.current_enrichment_failures, currentEnrichmentJobs);
    const baselineEnrichmentFailureRate = rate(row.baseline_enrichment_failures, baselineEnrichmentJobs);
    const currentMediaRequests = Number(row.current_media_delivery_requests || 0);
    const baselineMediaRequests = Number(row.baseline_media_delivery_requests || 0);
    const currentMediaFailureRate = rate(row.current_media_delivery_failures, currentMediaRequests);
    const baselineMediaFailureRate = rate(row.baseline_media_delivery_failures, baselineMediaRequests);

    if (currentExtractEvents >= 5 && baselineExtractEvents >= 20 && baselineExtractSuccessRate - currentExtractSuccessRate >= 0.15) {
      alerts.push({
        provider_id: row.provider_id,
        alert_type: "extract_success_drop",
        current_events: currentExtractEvents,
        baseline_events: baselineExtractEvents,
        current_rate: currentExtractSuccessRate,
        baseline_rate: baselineExtractSuccessRate,
        delta_rate: currentExtractSuccessRate - baselineExtractSuccessRate,
        severity_score: Math.round(100 * clamp01((baselineExtractSuccessRate - currentExtractSuccessRate) + currentExtractErrorRate)),
      });
    }
    if (currentExtractEvents >= 5 && baselineExtractEvents >= 20 && currentExtractErrorRate - baselineExtractErrorRate >= 0.2) {
      alerts.push({
        provider_id: row.provider_id,
        alert_type: "extract_error_spike",
        current_events: currentExtractEvents,
        baseline_events: baselineExtractEvents,
        current_rate: currentExtractErrorRate,
        baseline_rate: baselineExtractErrorRate,
        delta_rate: currentExtractErrorRate - baselineExtractErrorRate,
        severity_score: Math.round(100 * clamp01((currentExtractErrorRate - baselineExtractErrorRate) + rate(row.current_extract_failures, 10))),
      });
    }
    if (currentExtractEvents >= 5 && baselineDuration > 0 && currentDuration >= Math.max(1000, baselineDuration * 2)) {
      alerts.push({
        provider_id: row.provider_id,
        alert_type: "extract_latency_spike",
        current_events: currentExtractEvents,
        baseline_events: baselineExtractEvents,
        current_avg_duration_ms: currentDuration,
        baseline_avg_duration_ms: baselineDuration,
        duration_ratio: rate(currentDuration, baselineDuration),
        severity_score: Math.round(100 * clamp01(rate(currentDuration - baselineDuration, baselineDuration * 3))),
      });
    }
    if (currentEnrichmentJobs >= 3 && baselineEnrichmentJobs >= 10 && currentEnrichmentFailureRate - baselineEnrichmentFailureRate >= 0.25) {
      alerts.push({
        provider_id: row.provider_id,
        alert_type: "enrichment_failure_spike",
        current_events: currentEnrichmentJobs,
        baseline_events: baselineEnrichmentJobs,
        current_rate: currentEnrichmentFailureRate,
        baseline_rate: baselineEnrichmentFailureRate,
        delta_rate: currentEnrichmentFailureRate - baselineEnrichmentFailureRate,
        severity_score: Math.round(100 * clamp01(currentEnrichmentFailureRate - baselineEnrichmentFailureRate)),
      });
    }
    if (currentMediaRequests >= 5 && baselineMediaRequests >= 10 && currentMediaFailureRate - baselineMediaFailureRate >= 0.2) {
      alerts.push({
        provider_id: row.provider_id,
        alert_type: "media_delivery_failure_spike",
        current_events: currentMediaRequests,
        baseline_events: baselineMediaRequests,
        current_rate: currentMediaFailureRate,
        baseline_rate: baselineMediaFailureRate,
        delta_rate: currentMediaFailureRate - baselineMediaFailureRate,
        severity_score: Math.round(100 * clamp01(currentMediaFailureRate - baselineMediaFailureRate)),
      });
    }
  }
  return alerts
    .sort((a, b) => Number(b.severity_score || 0) - Number(a.severity_score || 0))
    .slice(0, 80)
    .map(maskRow);
}

function rowNumber(row: Row, key: string) {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : 0;
}

function buildDecisionInsights(input: {
  analyticsQuality: { metricNullRates?: Row[]; providerDataErrors?: Row[]; providerRateLimits?: Row[] };
  providerAnomalySignals: Row[];
  providerAccountHealth: Row[];
  settingChangeImpact: Row[];
  settingAttributionSummary?: Row[];
  funnelAnalytics: Row[];
  mediaDelivery7d: Row[];
  audienceCorrelation7d?: Row[];
  seasonality30d?: { hours?: Row[]; weekdays?: Row[]; providerWeekdays?: Row[] };
  eventDaySpikes30d?: { days?: Row[]; providers?: Row[] };
}) {
  const insights: Row[] = [];
  for (const row of input.providerAnomalySignals.slice(0, 12)) {
    insights.push({
      priority_score: rowNumber(row, "severity_score"),
      audience: "operations",
      insight_type: row.alert_type || "provider_anomaly",
      provider_id: row.provider_id,
      account_key: row.account_key || null,
      title: "Provider degradation detected",
      recommendation: "Check provider API status, recent parser changes, and rate-limit/error logs before it affects user-facing reliability.",
      evidence: `current=${row.current_rate ?? row.current_avg_duration_ms}, baseline=${row.baseline_rate ?? row.baseline_avg_duration_ms}`,
    });
  }

  for (const row of (input.analyticsQuality.metricNullRates || []).slice(0, 40)) {
    const nullRate = rowNumber(row, "null_rate");
    const required = row.required === true || String(row.required) === "1";
    if (rowNumber(row, "content_events") < PRIVACY_MIN_GROUP_SIZE || (!required && nullRate < 0.7) || (required && nullRate < 0.3)) continue;
    insights.push({
      priority_score: Math.round(100 * clamp01(nullRate + (required ? 0.25 : 0))),
      audience: "data_quality",
      insight_type: required ? "required_metric_gap" : "optional_metric_gap",
      provider_id: row.provider_id,
      metric_key: row.metric_key,
      title: required ? "Required provider metric coverage is weak" : "Provider metric is often unavailable",
      recommendation: required
        ? "Prioritize parser/API validation for this provider metric because downstream marketing dashboards depend on it."
        : "Keep this as a quality watch item; promote it only after coverage improves.",
      evidence: `coverage=${row.coverage_rate}, null=${row.null_rate}, events=${row.content_events}`,
    });
  }

  for (const row of input.providerAccountHealth.slice(0, 30)) {
    const health = rowNumber(row, "health_score");
    if (health >= 55) continue;
    insights.push({
      priority_score: 100 - health,
      audience: "provider_marketing",
      insight_type: "provider_account_health_low",
      provider_id: row.provider_id,
      account_key: row.account_key,
      title: "Provider account health is weak",
      recommendation: "Review extraction reliability, enrichment success, freshness, and provider errors before showing this account as a marketing success case.",
      evidence: `health=${health}, extract=${row.extract_success_rate}, enrichment=${row.enrichment_success_rate}, errors=${row.error_rate}`,
    });
  }

  for (const row of input.settingChangeImpact.slice(0, 20)) {
    const changeRate = rowNumber(row, "change_rate");
    if (Math.abs(changeRate) < 0.2) continue;
    insights.push({
      priority_score: Math.round(70 * clamp01(Math.abs(changeRate))),
      audience: "guild_admin_preview",
      insight_type: changeRate > 0 ? "setting_positive_impact" : "setting_negative_impact",
      provider_id: row.provider_id,
      setting_key: row.setting_key,
      title: changeRate > 0 ? "Setting change appears to increase usage" : "Setting change may have reduced usage",
      recommendation: changeRate > 0
        ? "Consider surfacing this as a recommended configuration pattern after more data accumulates."
        : "Review this setting change before exposing similar recommendations to server administrators.",
      evidence: `before=${row.content_before}, after=${row.content_after}, change=${row.change_rate}`,
    });
  }

  for (const row of (input.settingAttributionSummary || []).slice(0, 20)) {
    const changes = rowNumber(row, "changes");
    const usersAfter = rowNumber(row, "unique_users");
    const changeRate = rowNumber(row, "change_rate");
    if (changes < 1 || usersAfter < PRIVACY_MIN_GROUP_SIZE || changeRate < 0.25) continue;
    insights.push({
      priority_score: Math.round(Math.min(100, 35 + changeRate * 40 + usersAfter)),
      audience: "guild_admin_preview",
      insight_type: "setting_attribution",
      provider_id: row.provider_id,
      setting_key: row.setting_key,
      title: "A setting change is associated with higher usage",
      recommendation: "Review this setting pattern for rollout guidance; compare success rates and user reach before applying it broadly.",
      evidence: `type=${row.attribution_type}, direction=${row.setting_direction}, change_rate=${row.change_rate}, users=${row.unique_users}`,
    });
  }

  for (const row of input.funnelAnalytics.slice(0, 30)) {
    const extractSuccess = rowNumber(row, "extract_success_rate");
    const sendSuccess = rowNumber(row, "send_success_rate");
    const events = rowNumber(row, "url_posts");
    if (events < 20 || (extractSuccess >= 0.9 && sendSuccess >= 0.95)) continue;
    insights.push({
      priority_score: Math.round(100 * clamp01((1 - extractSuccess) + (1 - sendSuccess))),
      audience: "operations",
      insight_type: "funnel_dropoff",
      provider_id: row.provider_id,
      account_key: row.account_key,
      title: "Funnel drop-off is visible",
      recommendation: "Inspect extract failures and Discord send failures for this provider/account; improving this path directly raises user-visible value.",
      evidence: `posts=${row.url_posts}, extract=${row.extract_success_rate}, send=${row.send_success_rate}`,
    });
  }

  for (const row of input.mediaDelivery7d.slice(0, 12)) {
    const requests = rowNumber(row, "requests");
    const successRate = rowNumber(row, "success_rate");
    if (requests < 10 || successRate < 0.9) continue;
    insights.push({
      priority_score: Math.round(30 + Math.min(50, requests)),
      audience: "guild_admin_preview",
      insight_type: "media_delivery_value",
      provider_id: row.provider_id,
      account_key: row.account_key,
      title: "Media delivery is proving user value",
      recommendation: "Use this provider/account as evidence that attachments/download flows create measurable value beyond embeds.",
      evidence: `requests=${row.requests}, success=${row.success_rate}, urls=${row.urls}`,
    });
  }

  for (const row of (input.audienceCorrelation7d || []).slice(0, 12)) {
    const sharedUsers = rowNumber(row, "shared_users");
    const lift = rowNumber(row, "lift");
    if (sharedUsers < PRIVACY_MIN_GROUP_SIZE || lift < 1.5) continue;
    insights.push({
      priority_score: Math.round(Math.min(100, sharedUsers * lift)),
      audience: "provider_marketing_preview",
      insight_type: "audience_affinity",
      provider_id: row.target_provider_id,
      account_key: row.target_account_key,
      title: "Audience affinity is measurably above baseline",
      recommendation: "Use the paired provider/account as a targeting, collaboration, or content-positioning clue; the score is computed from anonymized aggregate reach.",
      evidence: `shared_users=${row.shared_users}, lift=${row.lift}, interest=${row.interest_provider_id}/${row.interest_account_key}`,
    });
  }

  const peakHours = [...(input.seasonality30d?.hours || [])]
    .sort((left, right) => rowNumber(right, "content_events") - rowNumber(left, "content_events"))
    .slice(0, 6);
  for (const row of peakHours) {
    const contentEvents = rowNumber(row, "content_events");
    const uniqueUsers = rowNumber(row, "unique_users");
    if (contentEvents < 10 || uniqueUsers < PRIVACY_MIN_GROUP_SIZE) continue;
    insights.push({
      priority_score: Math.round(Math.min(80, 20 + contentEvents / 5)),
      audience: "guild_admin_preview",
      insight_type: "seasonal_peak_hour",
      provider_id: null,
      account_key: null,
      title: "A repeatable peak usage hour is visible",
      recommendation: "Surface this hour in server-admin analytics as the best timing hint for announcements and provider rollout checks.",
      evidence: `hour_utc=${row.hour_utc}, content_events=${row.content_events}, users=${row.unique_users}`,
    });
  }

  for (const row of (input.eventDaySpikes30d?.providers || []).slice(0, 12)) {
    const lift = rowNumber(row, "event_day_lift");
    const contentEvents = rowNumber(row, "content_events");
    const uniqueUsers = rowNumber(row, "unique_users");
    if (contentEvents < 10 || uniqueUsers < PRIVACY_MIN_GROUP_SIZE || lift < 1.75) continue;
    insights.push({
      priority_score: Math.round(Math.min(100, 25 + contentEvents * lift)),
      audience: "provider_marketing_preview",
      insight_type: "event_day_spike",
      provider_id: row.provider_id,
      account_key: null,
      title: "A provider had an event-day response spike",
      recommendation: "Review the day, provider, and content mix to identify launches, external events, campaigns, or community moments worth repeating.",
      evidence: `day=${row.day_at}, provider=${row.provider_id}, lift=${row.event_day_lift}, content_events=${row.content_events}`,
    });
  }

  return insights
    .sort((a, b) => rowNumber(b, "priority_score") - rowNumber(a, "priority_score"))
    .slice(0, 80)
    .map(maskRow);
}

async function getProviderAccountHourly(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       provider_id,
       account_key,
       HOUR(FROM_UNIXTIME(occurred_at_ms / 1000)) AS hour_of_day,
       COUNT(*) AS extracts,
       COUNT(DISTINCT author_user_id) AS unique_users,
       COUNT(DISTINCT guild_id) AS unique_guilds
     FROM bot_analytics_events
     WHERE occurred_at_ms >= ?
       AND event_type = 'provider_extract'
       AND provider_id IS NOT NULL
       AND account_key IS NOT NULL
     GROUP BY provider_id, account_key, hour_of_day
     ORDER BY extracts DESC
     LIMIT 120`,
    startMs,
  );
  return rows.map(maskRow);
}

async function getProviderContentHourly(startMs: number) {
  const [aggregateRows, uniqueRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         provider_id,
         account_key,
         HOUR(FROM_UNIXTIME(bucket_start_ms / 1000)) AS hour_of_day,
         SUM(content_events) AS content_events,
         SUM(media_count_sum) AS media_count_sum,
         SUM(duration_seconds_sum) AS duration_seconds_sum,
         SUM(duration_seconds_count) AS duration_seconds_count
       FROM bot_provider_hourly_aggregates
       WHERE bucket_start_ms >= ?
         AND event_type = 'provider_content'
         AND provider_id <> ''
         AND account_key <> ''
       GROUP BY provider_id, account_key, hour_of_day
       ORDER BY content_events DESC
       LIMIT 160`,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         provider_id,
         account_key,
         HOUR(FROM_UNIXTIME(bucket_start_ms / 1000)) AS hour_of_day,
         key_type,
         COUNT(DISTINCT key_hash) AS unique_count
       FROM bot_provider_hourly_unique_keys
       WHERE bucket_start_ms >= ?
         AND event_type = 'provider_content'
         AND provider_id <> ''
         AND account_key <> ''
         AND key_type IN ('author_user', 'guild')
       GROUP BY provider_id, account_key, hour_of_day, key_type`,
      startMs,
    ),
  ]);
  const uniqueMap = new Map<string, { unique_users?: unknown; unique_guilds?: unknown }>();
  for (const row of uniqueRows) {
    const key = `${row.provider_id || ""}\u0001${row.account_key || ""}\u0001${row.hour_of_day || ""}`;
    const current = uniqueMap.get(key) || {};
    if (row.key_type === "author_user") current.unique_users = row.unique_count;
    if (row.key_type === "guild") current.unique_guilds = row.unique_count;
    uniqueMap.set(key, current);
  }
  return aggregateRows.map((row) => {
    const key = `${row.provider_id || ""}\u0001${row.account_key || ""}\u0001${row.hour_of_day || ""}`;
    return {
      ...maskRow(row),
      ...(uniqueMap.get(key) || {}),
      avg_media_count: rate(row.media_count_sum, row.content_events),
      avg_duration_seconds: rate(row.duration_seconds_sum, row.duration_seconds_count),
      data_source: "hourly_aggregate",
    };
  });
}

async function getProviderContentGuildShare(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       provider_id,
       account_key,
       guild_id,
       COUNT(*) AS content_events,
       COUNT(DISTINCT author_user_id) AS unique_users
     FROM bot_provider_content_events
     WHERE occurred_at_ms >= ?
       AND provider_id IS NOT NULL
       AND account_key IS NOT NULL
       AND guild_id IS NOT NULL
     GROUP BY provider_id, account_key, guild_id
     ORDER BY content_events DESC
     LIMIT 200`,
    startMs,
  );
  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.provider_id || ""}\u0001${row.account_key || ""}`;
    totals.set(key, (totals.get(key) || 0) + Number(row.content_events || 0));
  }
  return rows.map((row) => {
    const key = `${row.provider_id || ""}\u0001${row.account_key || ""}`;
    return {
      ...maskRow(row),
      account_share: rate(row.content_events, totals.get(key) || 0),
    };
  });
}

async function getProviderContentFacets(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       provider_id,
       account_key,
       facet_key,
       facet_value,
       COUNT(*) AS count,
       AVG(numeric_value) AS avg_numeric_value,
       SUM(numeric_value) AS sum_numeric_value,
       COUNT(DISTINCT content_event_id) AS content_events
     FROM bot_provider_content_facets
     WHERE occurred_at_ms >= ?
     GROUP BY provider_id, account_key, facet_key, facet_value
     ORDER BY count DESC
     LIMIT 200`,
    startMs,
  );
  return rows.map(maskRow);
}

async function getProviderContentUrls(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       provider_id,
       account_key,
       content_type,
       content_url,
       normalized_url,
       title,
       COUNT(*) AS content_events,
       COUNT(DISTINCT author_user_id) AS unique_users,
       COUNT(DISTINCT guild_id) AS unique_guilds,
       AVG(media_count) AS avg_media_count
     FROM bot_provider_content_events
     WHERE occurred_at_ms >= ?
       AND (content_url IS NOT NULL OR normalized_url IS NOT NULL)
     GROUP BY provider_id, account_key, content_type, content_url, normalized_url, title
     ORDER BY content_events DESC
     LIMIT 120`,
    startMs,
  );
  return rows.map(maskRow);
}

async function getProviderGuildShare(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       provider_id,
       account_key,
       guild_id,
       COUNT(*) AS extracts,
       COUNT(DISTINCT author_user_id) AS unique_users
     FROM bot_analytics_events
     WHERE occurred_at_ms >= ?
       AND event_type = 'provider_extract'
       AND provider_id IS NOT NULL
       AND account_key IS NOT NULL
       AND guild_id IS NOT NULL
     GROUP BY provider_id, account_key, guild_id
     ORDER BY extracts DESC
     LIMIT 160`,
    startMs,
  );
  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.provider_id || ""}\u0001${row.account_key || ""}`;
    totals.set(key, (totals.get(key) || 0) + Number(row.extracts || 0));
  }
  return rows.map((row) => {
    const key = `${row.provider_id || ""}\u0001${row.account_key || ""}`;
    return {
      ...maskRow(row),
      account_share: rate(row.extracts, totals.get(key) || 0),
    };
  });
}

async function getUrlAnalytics(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       provider_id,
       account_key,
       raw_url,
       normalized_url,
       COUNT(*) AS extracts,
       COUNT(DISTINCT author_user_id) AS unique_users,
       COUNT(DISTINCT guild_id) AS unique_guilds,
       SUM(success = 1) AS successes,
       SUM(success = 0) AS failures
     FROM bot_analytics_events
     WHERE occurred_at_ms >= ?
       AND event_type = 'provider_extract'
       AND (raw_url IS NOT NULL OR normalized_url IS NOT NULL)
     GROUP BY provider_id, account_key, raw_url, normalized_url
     ORDER BY extracts DESC
     LIMIT 80`,
    startMs,
  );
  return rows.map((row) => ({
    ...maskRow(row),
    success_rate: rate(row.successes, Number(row.successes || 0) + Number(row.failures || 0)),
  }));
}

async function getAudienceInterestAnalytics(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       target.provider_id AS target_provider_id,
       target.account_key AS target_account_key,
       other.provider_id AS interest_provider_id,
       other.account_key AS interest_account_key,
       other.endpoint_key AS interest_endpoint_key,
       COUNT(*) AS co_activity,
       COUNT(DISTINCT target.author_user_id) AS shared_users,
       COUNT(DISTINCT target.guild_id) AS shared_guilds
     FROM bot_analytics_events target
     JOIN bot_analytics_events other
       ON other.author_user_id = target.author_user_id
      AND other.event_type = 'provider_extract'
      AND other.occurred_at_ms >= ?
     WHERE target.occurred_at_ms >= ?
       AND target.event_type = 'provider_extract'
       AND target.author_user_id IS NOT NULL
       AND target.account_key IS NOT NULL
       AND other.provider_id IS NOT NULL
       AND (
         other.provider_id <> target.provider_id
         OR COALESCE(other.account_key, '') <> COALESCE(target.account_key, '')
       )
     GROUP BY target.provider_id, target.account_key, other.provider_id, other.account_key, other.endpoint_key
     ORDER BY co_activity DESC
     LIMIT 100`,
    startMs,
    startMs,
  );
  return rows.map(maskRow);
}

export type AdminDetailedAnalyticsFilters = {
  providerId?: string | null;
  accountKey?: string | null;
  guildId?: string | null;
  authorUserId?: string | null;
  eventType?: string | null;
  commandName?: string | null;
  componentId?: string | null;
  contentType?: string | null;
  facetKey?: string | null;
  dateFrom?: string | number | null;
  dateTo?: string | number | null;
  bucket?: string | null;
  limit?: string | number | null;
};

function cleanFilter(value: unknown) {
  if (value === null || value === undefined) return null;
  const textValue = String(value).trim();
  return textValue ? textValue : null;
}

function parseTimestampMs(value: string | number | null | undefined) {
  const cleaned = cleanFilter(value);
  if (!cleaned) return null;
  const numeric = Number(cleaned);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function detailedAnalyticsWindow(filters: AdminDetailedAnalyticsFilters) {
  const now = Date.now();
  const requestedStart = parseTimestampMs(filters.dateFrom);
  const requestedEnd = parseTimestampMs(filters.dateTo);
  const rawStart = requestedStart ?? now - 7 * DAY_MS;
  const rawEnd = requestedEnd ?? now;
  const startMs = Math.min(rawStart, rawEnd);
  const endMs = Math.max(rawStart, rawEnd);
  const spanMs = Math.max(endMs - startMs, HOUR_MS);
  const requestedBucket = cleanFilter(filters.bucket);
  const bucketMs = requestedBucket === "day" ? DAY_MS : requestedBucket === "hour" ? HOUR_MS : spanMs > 14 * DAY_MS ? DAY_MS : HOUR_MS;
  return { now, startMs, endMs, bucketMs };
}

function appendEquals(clauses: string[], params: unknown[], column: string, value: unknown) {
  const cleaned = cleanFilter(value);
  if (!cleaned) return;
  clauses.push(`${column} = ?`);
  params.push(cleaned);
}

function contentWhere(
  filters: AdminDetailedAnalyticsFilters,
  window: { startMs: number; endMs: number },
  alias = "c",
  options: { includeFacetFilter?: boolean } = {},
) {
  const clauses = [`${alias}.occurred_at_ms >= ?`, `${alias}.occurred_at_ms <= ?`];
  const params: unknown[] = [window.startMs, window.endMs];
  appendEquals(clauses, params, `${alias}.provider_id`, filters.providerId);
  appendEquals(clauses, params, `${alias}.account_key`, filters.accountKey);
  appendEquals(clauses, params, `${alias}.guild_id`, filters.guildId);
  appendEquals(clauses, params, `${alias}.author_user_id`, filters.authorUserId);
  appendEquals(clauses, params, `${alias}.content_type`, filters.contentType);
  const facetKey = cleanFilter(filters.facetKey);
  if (facetKey && options.includeFacetFilter !== false) {
    clauses.push(
      `EXISTS (
        SELECT 1
        FROM bot_provider_content_facets f_filter
        WHERE f_filter.content_event_id = ${alias}.content_event_id
          AND f_filter.facet_key = ?
      )`,
    );
    params.push(facetKey);
  }
  return { whereSql: clauses.join(" AND "), params };
}

function analyticsWhere(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, alias = "a") {
  const clauses = [`${alias}.occurred_at_ms >= ?`, `${alias}.occurred_at_ms <= ?`];
  const params: unknown[] = [window.startMs, window.endMs];
  appendEquals(clauses, params, `${alias}.provider_id`, filters.providerId);
  appendEquals(clauses, params, `${alias}.account_key`, filters.accountKey);
  appendEquals(clauses, params, `${alias}.guild_id`, filters.guildId);
  appendEquals(clauses, params, `${alias}.author_user_id`, filters.authorUserId);
  appendEquals(clauses, params, `${alias}.event_type`, filters.eventType);
  appendEquals(clauses, params, `${alias}.command_name`, filters.commandName);
  appendEquals(clauses, params, `${alias}.component_id`, filters.componentId);
  return { whereSql: clauses.join(" AND "), params };
}

function firstMaskedRow(rows: Array<Record<string, unknown>>) {
  return maskRow(rows[0] || {});
}

async function getDetailedSummary(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }): Promise<{ content: Row; analytics: Row }> {
  const content = contentWhere(filters, window);
  const analytics = analyticsWhere(filters, window);
  const [contentRows, analyticsRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         COUNT(*) AS content_events,
         COUNT(DISTINCT c.provider_id) AS providers,
         COUNT(DISTINCT c.account_key) AS accounts,
         COUNT(DISTINCT c.content_id) AS content_ids,
         COUNT(DISTINCT c.normalized_url) AS urls,
         COUNT(DISTINCT c.guild_id) AS guilds,
         COUNT(DISTINCT c.author_user_id) AS users,
         SUM(c.\`sensitive\` = 1) AS sensitive_events,
         AVG(c.media_count) AS avg_media_count,
         AVG(c.duration_seconds) AS avg_duration_seconds
       FROM bot_provider_content_events c
       WHERE ${content.whereSql}`,
      ...content.params,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         COUNT(*) AS analytics_events,
         SUM(a.count) AS weighted_events,
         COUNT(DISTINCT a.provider_id) AS providers,
         COUNT(DISTINCT a.account_key) AS accounts,
         COUNT(DISTINCT a.guild_id) AS guilds,
         COUNT(DISTINCT a.author_user_id) AS users,
         SUM(a.success = 1) AS successes,
         SUM(a.success = 0) AS failures,
         AVG(a.duration_ms) AS avg_duration_ms,
         MAX(a.duration_ms) AS max_duration_ms
       FROM bot_analytics_events a
       WHERE ${analytics.whereSql}`,
      ...analytics.params,
    ),
  ]);
  const analyticsSummary = analyticsRows[0] || {};
  return {
    content: firstMaskedRow(contentRows),
    analytics: {
      ...maskRow(analyticsSummary),
      success_rate: rate(analyticsSummary.successes, Number(analyticsSummary.successes || 0) + Number(analyticsSummary.failures || 0)),
    },
  };
}

async function getDetailedTimeSeries(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number; bucketMs: number }) {
  const content = contentWhere(filters, window);
  const analytics = analyticsWhere(filters, window);
  const [contentRows, analyticsRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         FLOOR(c.occurred_at_ms / ?) * ? AS bucket_start_ms,
         COUNT(*) AS content_events,
         COUNT(DISTINCT c.author_user_id) AS content_users,
         COUNT(DISTINCT c.guild_id) AS content_guilds,
         COUNT(DISTINCT c.account_key) AS content_accounts
       FROM bot_provider_content_events c
       WHERE ${content.whereSql}
       GROUP BY bucket_start_ms
       ORDER BY bucket_start_ms ASC
       LIMIT 500`,
      window.bucketMs,
      window.bucketMs,
      ...content.params,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         FLOOR(a.occurred_at_ms / ?) * ? AS bucket_start_ms,
         COUNT(*) AS analytics_events,
         SUM(a.success = 1) AS successes,
         SUM(a.success = 0) AS failures,
         AVG(a.duration_ms) AS avg_duration_ms
       FROM bot_analytics_events a
       WHERE ${analytics.whereSql}
       GROUP BY bucket_start_ms
       ORDER BY bucket_start_ms ASC
       LIMIT 500`,
      window.bucketMs,
      window.bucketMs,
      ...analytics.params,
    ),
  ]);
  const byBucket = new Map<string, Record<string, unknown>>();
  for (const row of contentRows) byBucket.set(String(row.bucket_start_ms), maskRow(row));
  for (const row of analyticsRows) {
    const key = String(row.bucket_start_ms);
    const existing = byBucket.get(key) || { bucket_start_ms: row.bucket_start_ms };
    byBucket.set(key, {
      ...existing,
      ...maskRow(row),
      success_rate: rate(row.successes, Number(row.successes || 0) + Number(row.failures || 0)),
    });
  }
  return [...byBucket.values()].sort((left, right) => Number(left.bucket_start_ms || 0) - Number(right.bucket_start_ms || 0));
}

async function getDetailedProviderAccounts(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const content = contentWhere(filters, window);
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       c.provider_id,
       c.account_key,
       COUNT(*) AS content_events,
       COUNT(DISTINCT c.author_user_id) AS users,
       COUNT(DISTINCT c.guild_id) AS guilds,
       COUNT(DISTINCT c.normalized_url) AS urls,
       SUM(c.\`sensitive\` = 1) AS sensitive_events,
       AVG(c.media_count) AS avg_media_count,
       AVG(c.duration_seconds) AS avg_duration_seconds,
       MAX(c.occurred_at_ms) AS latest_ms
     FROM bot_provider_content_events c
     WHERE ${content.whereSql}
     GROUP BY c.provider_id, c.account_key
     ORDER BY content_events DESC
     LIMIT ?`,
    ...content.params,
    limit,
  );
  return rows.map((row) => ({
    ...maskRow(row),
    sensitive_rate: rate(row.sensitive_events, row.content_events),
  }));
}

async function getDetailedProviderReliability(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const analytics = analyticsWhere(filters, window);
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       a.provider_id,
       a.account_key,
       a.event_type,
       COUNT(*) AS events,
       SUM(a.success = 1) AS successes,
       SUM(a.success = 0) AS failures,
       COUNT(DISTINCT a.author_user_id) AS users,
       COUNT(DISTINCT a.guild_id) AS guilds,
       AVG(a.duration_ms) AS avg_duration_ms,
       MAX(a.duration_ms) AS max_duration_ms
     FROM bot_analytics_events a
     WHERE ${analytics.whereSql}
       AND a.provider_id IS NOT NULL
       AND a.success IS NOT NULL
     GROUP BY a.provider_id, a.account_key, a.event_type
     ORDER BY events DESC
     LIMIT ?`,
    ...analytics.params,
    limit,
  );
  return rows.map((row) => ({
    ...maskRow(row),
    success_rate: rate(row.successes, Number(row.successes || 0) + Number(row.failures || 0)),
  }));
}

async function getDetailedContentTypeBreakdown(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const content = contentWhere(filters, window);
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       c.provider_id,
       c.content_type,
       COUNT(*) AS content_events,
       COUNT(DISTINCT c.account_key) AS accounts,
       COUNT(DISTINCT c.author_user_id) AS users,
       COUNT(DISTINCT c.guild_id) AS guilds,
       AVG(c.media_count) AS avg_media_count,
       AVG(c.duration_seconds) AS avg_duration_seconds
     FROM bot_provider_content_events c
     WHERE ${content.whereSql}
     GROUP BY c.provider_id, c.content_type
     ORDER BY content_events DESC
     LIMIT ?`,
    ...content.params,
    limit,
  );
  return rows.map(maskRow);
}

async function getDetailedGuildBreakdown(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const content = contentWhere(filters, window);
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       c.guild_id,
       COUNT(*) AS content_events,
       COUNT(DISTINCT c.provider_id) AS providers,
       COUNT(DISTINCT c.account_key) AS accounts,
       COUNT(DISTINCT c.author_user_id) AS users,
       COUNT(DISTINCT c.normalized_url) AS urls
     FROM bot_provider_content_events c
     WHERE ${content.whereSql}
       AND c.guild_id IS NOT NULL
     GROUP BY c.guild_id
     ORDER BY content_events DESC
     LIMIT ?`,
    ...content.params,
    limit,
  );
  return rows.map(maskRow);
}

async function getDetailedUserCohortBreakdown(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const content = contentWhere(filters, window);
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       usage_bucket,
       COUNT(*) AS users,
       SUM(content_events) AS content_events,
       AVG(content_events) AS avg_events_per_user,
       AVG(providers) AS avg_providers_per_user,
       AVG(accounts) AS avg_accounts_per_user,
       AVG(guilds) AS avg_guilds_per_user,
       AVG(urls) AS avg_urls_per_user,
       MAX(latest_ms) AS latest_ms
     FROM (
       SELECT
         user_stats.*,
         CASE
           WHEN user_stats.content_events = 1 THEN '1 event'
           WHEN user_stats.content_events BETWEEN 2 AND 4 THEN '2-4 events'
           WHEN user_stats.content_events BETWEEN 5 AND 9 THEN '5-9 events'
           WHEN user_stats.content_events BETWEEN 10 AND 24 THEN '10-24 events'
           ELSE '25+ events'
         END AS usage_bucket,
         CASE
           WHEN user_stats.content_events = 1 THEN 1
           WHEN user_stats.content_events BETWEEN 2 AND 4 THEN 2
           WHEN user_stats.content_events BETWEEN 5 AND 9 THEN 3
           WHEN user_stats.content_events BETWEEN 10 AND 24 THEN 4
           ELSE 5
         END AS bucket_order
       FROM (
         SELECT
           c.author_user_id,
           COUNT(*) AS content_events,
           COUNT(DISTINCT c.provider_id) AS providers,
           COUNT(DISTINCT c.account_key) AS accounts,
           COUNT(DISTINCT c.guild_id) AS guilds,
           COUNT(DISTINCT c.normalized_url) AS urls,
           MAX(c.occurred_at_ms) AS latest_ms
         FROM bot_provider_content_events c
         WHERE ${content.whereSql}
           AND c.author_user_id IS NOT NULL
         GROUP BY c.author_user_id
       ) user_stats
     ) user_buckets
     GROUP BY usage_bucket, bucket_order
     ORDER BY bucket_order ASC
     LIMIT ?`,
    ...content.params,
    limit,
  );
  return protectSmallGroupRows(rows.map(maskRow));
}

async function getDetailedUrlBreakdown(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const content = contentWhere(filters, window);
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       c.provider_id,
       c.account_key,
       c.content_url,
       c.normalized_url,
       MAX(c.title) AS title,
       MAX(c.author_name) AS author_name,
       COUNT(*) AS content_events,
       COUNT(DISTINCT c.author_user_id) AS users,
       COUNT(DISTINCT c.guild_id) AS guilds,
       MAX(c.occurred_at_ms) AS latest_ms
     FROM bot_provider_content_events c
     WHERE ${content.whereSql}
       AND (c.content_url IS NOT NULL OR c.normalized_url IS NOT NULL)
     GROUP BY c.provider_id, c.account_key, c.content_url, c.normalized_url
     ORDER BY content_events DESC
     LIMIT ?`,
    ...content.params,
    limit,
  );
  return rows.map(maskRow);
}

function valueDriverMergeKey(row: Row) {
  return [
    row.driver_type,
    row.provider_id ?? "",
    row.account_key ?? "",
    row.driver_type === "content_type" ? row.content_type ?? "" : "",
    row.url_hash ?? "",
  ].map(String).join("\x1f");
}

function valueDriverTier(score: number) {
  if (score >= 120) return "core_driver";
  if (score >= 60) return "growth_driver";
  if (score >= 25) return "emerging_driver";
  return "watch";
}

function valueDriverSignal(row: Row, successRate: number | null) {
  const users = rowNumber(row, "users");
  const guilds = rowNumber(row, "guilds");
  const events = rowNumber(row, "content_events");
  if (successRate !== null && successRate < 0.85) return "demand_with_reliability_risk";
  if (guilds >= 5 && users >= 5) return "cross_guild_reach";
  if (users >= 5 && events >= users * 3) return "repeat_interest";
  if (events >= 20) return "high_volume";
  return "early_signal";
}

function decorateValueDriverRows(rows: Row[], reliabilityRows: Row[]) {
  const reliabilityByKey = new Map(reliabilityRows.map((row) => [valueDriverMergeKey(row), row]));
  const decorated = rows.map((row) => {
    const reliability = reliabilityByKey.get(valueDriverMergeKey(row));
    const successes = rowNumber(reliability || {}, "successes");
    const failures = rowNumber(reliability || {}, "failures");
    const extractSuccesses = rowNumber(reliability || {}, "provider_extract_successes");
    const extractFailures = rowNumber(reliability || {}, "provider_extract_failures");
    const sendSuccesses = rowNumber(reliability || {}, "discord_send_successes");
    const sendFailures = rowNumber(reliability || {}, "discord_send_failures");
    const successRate = optionalRate(successes, successes + failures);
    const extractSuccessRate = optionalRate(extractSuccesses, extractSuccesses + extractFailures);
    const sendSuccessRate = optionalRate(sendSuccesses, sendSuccesses + sendFailures);
    const contentEvents = rowNumber(row, "content_events");
    const users = rowNumber(row, "users");
    const guilds = rowNumber(row, "guilds");
    const urls = Math.max(rowNumber(row, "urls"), row.driver_type === "url" ? 1 : 0);
    const accounts = rowNumber(row, "accounts");
    const contentIds = rowNumber(row, "content_ids");
    const baseScore = contentEvents + users * 4 + guilds * 3 + urls * 2 + accounts * 2 + contentIds;
    const reliabilityMultiplier = successRate === null ? 1 : 0.6 + successRate * 0.4;
    const valueScore = Math.round(baseScore * reliabilityMultiplier);
    const visibleRow = { ...row };
    delete visibleRow.url_hash;
    const contentUrl = typeof row.content_url === "string" ? row.content_url : "";
    return maskRow({
      ...visibleRow,
      analytics_events: reliability ? reliability.analytics_events : null,
      successes: reliability ? successes : null,
      failures: reliability ? failures : null,
      success_rate: successRate,
      provider_extract_success_rate: extractSuccessRate,
      discord_send_success_rate: sendSuccessRate,
      avg_analytics_duration_ms: reliability ? reliability.avg_duration_ms : null,
      url_query_present: contentUrl.includes("?") || contentUrl.includes("#"),
      value_score: valueScore,
      value_tier: valueDriverTier(valueScore),
      value_signal: valueDriverSignal(row, successRate),
      analysis_model: "value_driver_summary",
      value_data_sources: reliability ? "bot_provider_content_events+bot_analytics_events" : "bot_provider_content_events",
    });
  });
  return protectSmallGroupRows(
    decorated.sort((left, right) => rowNumber(right, "value_score") - rowNumber(left, "value_score")),
  );
}

async function getDetailedValueDrivers(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const content = contentWhere(filters, window);
  const analytics = analyticsWhere(filters, window);
  const analyticsScopeMatchesContent = !cleanFilter(filters.contentType) && !cleanFilter(filters.facetKey);
  const [
    urlRows,
    providerRows,
    accountRows,
    contentTypeRows,
    urlReliabilityRows,
    scopeReliabilityRows,
  ] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         'url' AS driver_type,
         c.provider_id,
         c.account_key,
         c.content_type,
         c.content_url,
         c.normalized_url,
         c.url_hash,
         MAX(c.title) AS title,
         MAX(c.author_name) AS author_name,
         COUNT(*) AS content_events,
         COUNT(DISTINCT c.author_user_id) AS users,
         COUNT(DISTINCT c.guild_id) AS guilds,
         1 AS urls,
         COUNT(DISTINCT c.content_id) AS content_ids,
         AVG(c.media_count) AS avg_media_count,
         AVG(c.duration_seconds) AS avg_duration_seconds,
         MAX(c.occurred_at_ms) AS latest_ms
       FROM bot_provider_content_events c
       WHERE ${content.whereSql}
         AND (c.content_url IS NOT NULL OR c.normalized_url IS NOT NULL)
       GROUP BY c.provider_id, c.account_key, c.content_type, c.content_url, c.normalized_url, c.url_hash
       ORDER BY content_events DESC, users DESC, guilds DESC
       LIMIT ?`,
      ...content.params,
      limit,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         'provider' AS driver_type,
         c.provider_id,
         NULL AS account_key,
         NULL AS content_type,
         NULL AS content_url,
         NULL AS normalized_url,
         NULL AS url_hash,
         COUNT(*) AS content_events,
         COUNT(DISTINCT c.account_key) AS accounts,
         COUNT(DISTINCT c.author_user_id) AS users,
         COUNT(DISTINCT c.guild_id) AS guilds,
         COUNT(DISTINCT COALESCE(c.normalized_url, c.content_url)) AS urls,
         COUNT(DISTINCT c.content_id) AS content_ids,
         AVG(c.media_count) AS avg_media_count,
         AVG(c.duration_seconds) AS avg_duration_seconds,
         MAX(c.occurred_at_ms) AS latest_ms
       FROM bot_provider_content_events c
       WHERE ${content.whereSql}
       GROUP BY c.provider_id
       ORDER BY content_events DESC, users DESC, guilds DESC
       LIMIT ?`,
      ...content.params,
      limit,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         'provider_account' AS driver_type,
         c.provider_id,
         c.account_key,
         NULL AS content_type,
         NULL AS content_url,
         NULL AS normalized_url,
         NULL AS url_hash,
         COUNT(*) AS content_events,
         1 AS accounts,
         COUNT(DISTINCT c.author_user_id) AS users,
         COUNT(DISTINCT c.guild_id) AS guilds,
         COUNT(DISTINCT COALESCE(c.normalized_url, c.content_url)) AS urls,
         COUNT(DISTINCT c.content_id) AS content_ids,
         AVG(c.media_count) AS avg_media_count,
         AVG(c.duration_seconds) AS avg_duration_seconds,
         MAX(c.occurred_at_ms) AS latest_ms
       FROM bot_provider_content_events c
       WHERE ${content.whereSql}
       GROUP BY c.provider_id, c.account_key
       ORDER BY content_events DESC, users DESC, guilds DESC
       LIMIT ?`,
      ...content.params,
      limit,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         'content_type' AS driver_type,
         c.provider_id,
         NULL AS account_key,
         c.content_type,
         NULL AS content_url,
         NULL AS normalized_url,
         NULL AS url_hash,
         COUNT(*) AS content_events,
         COUNT(DISTINCT c.account_key) AS accounts,
         COUNT(DISTINCT c.author_user_id) AS users,
         COUNT(DISTINCT c.guild_id) AS guilds,
         COUNT(DISTINCT COALESCE(c.normalized_url, c.content_url)) AS urls,
         COUNT(DISTINCT c.content_id) AS content_ids,
         AVG(c.media_count) AS avg_media_count,
         AVG(c.duration_seconds) AS avg_duration_seconds,
         MAX(c.occurred_at_ms) AS latest_ms
       FROM bot_provider_content_events c
       WHERE ${content.whereSql}
       GROUP BY c.provider_id, c.content_type
       ORDER BY content_events DESC, users DESC, guilds DESC
       LIMIT ?`,
      ...content.params,
      limit,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         'url' AS driver_type,
         a.provider_id,
         a.account_key,
         NULL AS content_type,
         a.url_hash,
         COUNT(*) AS analytics_events,
         SUM(a.success = 1) AS successes,
         SUM(a.success = 0) AS failures,
         SUM(a.event_type = 'provider_extract' AND a.success = 1) AS provider_extract_successes,
         SUM(a.event_type = 'provider_extract' AND a.success = 0) AS provider_extract_failures,
         SUM(a.event_type = 'discord_send' AND a.success = 1) AS discord_send_successes,
         SUM(a.event_type = 'discord_send' AND a.success = 0) AS discord_send_failures,
         AVG(a.duration_ms) AS avg_duration_ms
       FROM bot_analytics_events a
       WHERE ${analytics.whereSql}
         AND a.provider_id IS NOT NULL
         AND a.url_hash IS NOT NULL
         AND a.success IS NOT NULL
       GROUP BY a.provider_id, a.account_key, a.url_hash
       LIMIT ?`,
      ...analytics.params,
      limit * 4,
    ),
    analyticsScopeMatchesContent
      ? prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT
           'provider' AS driver_type,
           a.provider_id,
           NULL AS account_key,
           NULL AS content_type,
           NULL AS url_hash,
           COUNT(*) AS analytics_events,
           SUM(a.success = 1) AS successes,
           SUM(a.success = 0) AS failures,
           SUM(a.event_type = 'provider_extract' AND a.success = 1) AS provider_extract_successes,
           SUM(a.event_type = 'provider_extract' AND a.success = 0) AS provider_extract_failures,
           SUM(a.event_type = 'discord_send' AND a.success = 1) AS discord_send_successes,
           SUM(a.event_type = 'discord_send' AND a.success = 0) AS discord_send_failures,
           AVG(a.duration_ms) AS avg_duration_ms
         FROM bot_analytics_events a
         WHERE ${analytics.whereSql}
           AND a.provider_id IS NOT NULL
           AND a.success IS NOT NULL
         GROUP BY a.provider_id
         UNION ALL
         SELECT
           'provider_account' AS driver_type,
           a.provider_id,
           a.account_key,
           NULL AS content_type,
           NULL AS url_hash,
           COUNT(*) AS analytics_events,
           SUM(a.success = 1) AS successes,
           SUM(a.success = 0) AS failures,
           SUM(a.event_type = 'provider_extract' AND a.success = 1) AS provider_extract_successes,
           SUM(a.event_type = 'provider_extract' AND a.success = 0) AS provider_extract_failures,
           SUM(a.event_type = 'discord_send' AND a.success = 1) AS discord_send_successes,
           SUM(a.event_type = 'discord_send' AND a.success = 0) AS discord_send_failures,
           AVG(a.duration_ms) AS avg_duration_ms
         FROM bot_analytics_events a
         WHERE ${analytics.whereSql}
           AND a.provider_id IS NOT NULL
           AND a.success IS NOT NULL
         GROUP BY a.provider_id, a.account_key`,
        ...analytics.params,
        ...analytics.params,
      )
      : Promise.resolve([]),
  ]);

  return decorateValueDriverRows(
    [...providerRows, ...accountRows, ...contentTypeRows, ...urlRows].slice(0, limit * 4),
    [...urlReliabilityRows, ...scopeReliabilityRows],
  );
}

function urlParameterSensitivity(key: unknown) {
  const text = String(key || "").toLowerCase();
  if (/(token|auth|session|secret|password|passwd|passcode|jwt|csrf|signature|sig|access|refresh|credential|apikey|api_key)/.test(text)) return "high";
  if (/(email|mail|phone|tel|address|discord|user|userid|user_id|uid|member|account|customer|client|invite|code)/.test(text)) return "medium";
  if (/^utm_|^(gclid|fbclid|yclid|msclkid|mc_cid|mc_eid|igshid|si|ref|ref_src|source|campaign|affiliate|tag)$/.test(text)) return "marketing";
  return "low";
}

function urlParameterFamily(key: unknown) {
  const text = String(key || "").toLowerCase();
  if (/^utm_|campaign/.test(text)) return "campaign";
  if (/(gclid|fbclid|yclid|msclkid|click|clid|mc_cid|mc_eid)/.test(text)) return "ad_tracking";
  if (/(ref|source|affiliate|tag|partner|share)/.test(text)) return "referral";
  if (/(token|auth|session|secret|password|jwt|csrf|signature|sig|access|refresh|credential|apikey|api_key)/.test(text)) return "credential_risk";
  if (/(email|mail|phone|tel|address|discord|user|userid|user_id|uid|member|account|customer|client|invite|code)/.test(text)) return "identifier_risk";
  return "general";
}

async function getDetailedUrlParameterBreakdown(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const content = contentWhere(filters, window, "c");
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       c.provider_id,
       c.account_key,
       c.content_type,
       f.facet_value AS query_key,
       COUNT(*) AS content_events,
       COUNT(DISTINCT c.author_user_id) AS users,
       COUNT(DISTINCT c.guild_id) AS guilds,
       COUNT(DISTINCT COALESCE(c.normalized_url, c.content_url)) AS urls,
       MAX(c.occurred_at_ms) AS latest_ms
     FROM bot_provider_content_facets f
     JOIN bot_provider_content_events c ON c.content_event_id = f.content_event_id
     WHERE ${content.whereSql}
       AND f.facet_key = 'url.query_param'
       AND f.facet_value IS NOT NULL
     GROUP BY c.provider_id, c.account_key, c.content_type, f.facet_value
     ORDER BY content_events DESC, users DESC, guilds DESC
     LIMIT ?`,
    ...content.params,
    limit,
  );
  return protectSmallGroupRows(rows.map((row) => maskRow({
    ...row,
    query_key_family: urlParameterFamily(row.query_key),
    privacy_sensitivity: urlParameterSensitivity(row.query_key),
    values_stored: false,
    analysis_model: "url_query_param_summary",
    metric_source: "url.query_param.extract",
  })));
}

function providerAxisDefinitions(providerId: unknown) {
  const requestedProvider = String(providerId || "").trim().toLowerCase();
  if (requestedProvider && PROVIDER_MARKETING_AXIS_SEGMENTS[requestedProvider]) {
    return { providers: [requestedProvider], axes: PROVIDER_MARKETING_AXIS_SEGMENTS[requestedProvider] };
  }
  const providers = Object.keys(PROVIDER_MARKETING_AXIS_SEGMENTS);
  return { providers, axes: providers.flatMap((provider) => PROVIDER_MARKETING_AXIS_SEGMENTS[provider]) };
}

function metricDefinitionsForProvider(providerId: string) {
  const schema = PROVIDER_METRIC_SCHEMA_REGISTRY[providerId];
  const definitions = new Map<string, { label: string; stage: string; required: boolean }>();
  if (!schema) return definitions;
  for (const metric of schema.metrics) {
    definitions.set(metric.key, { label: metric.label, stage: metric.stage, required: metric.required });
  }
  for (const facetKey of schema.facets) {
    if (!definitions.has(facetKey)) {
      definitions.set(facetKey, { label: facetKey.split(".").slice(1).join(".") || facetKey, stage: "initial", required: false });
    }
  }
  return definitions;
}

async function getDetailedProviderMarketingSegments(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const { providers } = providerAxisDefinitions(filters.providerId);
  const axesByProviderMetric = new Map<string, ProviderMarketingAxisDefinition[]>();
  const metricKeys = new Set<string>();
  for (const provider of providers) {
    for (const axis of PROVIDER_MARKETING_AXIS_SEGMENTS[provider] || []) {
      for (const metricKey of axis.metricKeys) {
        metricKeys.add(metricKey);
        const key = `${provider}\x1f${metricKey}`;
        const existing = axesByProviderMetric.get(key) || [];
        existing.push(axis);
        axesByProviderMetric.set(key, existing);
      }
    }
  }
  if (!metricKeys.size) return [];

  const content = contentWhere(filters, window, "c");
  const metricParams = [...metricKeys];
  const placeholders = metricParams.map(() => "?").join(", ");
  const segmentValueSql = `CASE
    WHEN f.facet_value IS NOT NULL AND f.facet_value <> '' THEN f.facet_value
    WHEN f.numeric_value IS NULL THEN NULL
    WHEN f.facet_key LIKE '%.duration_seconds' THEN CASE
      WHEN f.numeric_value < 15 THEN 'duration:<15s'
      WHEN f.numeric_value < 60 THEN 'duration:15-59s'
      WHEN f.numeric_value < 300 THEN 'duration:1-4m'
      WHEN f.numeric_value < 1200 THEN 'duration:5-19m'
      ELSE 'duration:20m+'
    END
    WHEN f.facet_key LIKE '%.price' THEN CASE
      WHEN f.numeric_value = 0 THEN 'price:free'
      WHEN f.numeric_value < 1000 THEN 'price:<1000'
      WHEN f.numeric_value < 5000 THEN 'price:1000-4999'
      WHEN f.numeric_value < 10000 THEN 'price:5000-9999'
      ELSE 'price:10000+'
    END
    WHEN f.facet_key LIKE '%.followers'
      OR f.facet_key LIKE '%.subscribers'
      OR f.facet_key LIKE '%.current_players'
      OR f.facet_key LIKE '%.live_viewers' THEN CASE
      WHEN f.numeric_value < 100 THEN 'audience:<100'
      WHEN f.numeric_value < 1000 THEN 'audience:100-999'
      WHEN f.numeric_value < 10000 THEN 'audience:1k-9k'
      WHEN f.numeric_value < 100000 THEN 'audience:10k-99k'
      ELSE 'audience:100k+'
    END
    WHEN f.facet_key LIKE '%.views'
      OR f.facet_key LIKE '%.plays'
      OR f.facet_key LIKE '%.likes'
      OR f.facet_key LIKE '%.comments'
      OR f.facet_key LIKE '%.shares'
      OR f.facet_key LIKE '%.reviews'
      OR f.facet_key LIKE '%.review_count'
      OR f.facet_key LIKE '%.stars'
      OR f.facet_key LIKE '%.forks'
      OR f.facet_key LIKE '%.watchers'
      OR f.facet_key LIKE '%.bookmarks'
      OR f.facet_key LIKE '%.mylists'
      OR f.facet_key LIKE '%.favorites'
      OR f.facet_key LIKE '%.recommendations' THEN CASE
      WHEN f.numeric_value < 10 THEN 'volume:<10'
      WHEN f.numeric_value < 100 THEN 'volume:10-99'
      WHEN f.numeric_value < 1000 THEN 'volume:100-999'
      WHEN f.numeric_value < 10000 THEN 'volume:1k-9k'
      ELSE 'volume:10k+'
    END
    ELSE CASE
      WHEN f.numeric_value < 1 THEN 'numeric:<1'
      WHEN f.numeric_value < 10 THEN 'numeric:1-9'
      WHEN f.numeric_value < 100 THEN 'numeric:10-99'
      WHEN f.numeric_value < 1000 THEN 'numeric:100-999'
      ELSE 'numeric:1000+'
    END
  END`;
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       segment.provider_id,
       segment.account_key,
       segment.metric_key,
       segment.facet_value,
       COUNT(*) AS events,
       COUNT(DISTINCT segment.author_user_id) AS users,
       COUNT(DISTINCT segment.guild_id) AS guilds,
       COUNT(DISTINCT segment.display_url) AS urls,
       AVG(segment.numeric_value) AS avg_numeric_value,
       SUM(segment.numeric_value) AS sum_numeric_value,
       MIN(segment.numeric_value) AS min_numeric_value,
       MAX(segment.numeric_value) AS max_numeric_value,
       MAX(segment.occurred_at_ms) AS latest_ms
     FROM (
       SELECT
         f.content_event_id,
         f.provider_id,
         f.account_key,
         f.facet_key AS metric_key,
         ${segmentValueSql} AS facet_value,
         AVG(f.numeric_value) AS numeric_value,
         MAX(c.author_user_id) AS author_user_id,
         MAX(c.guild_id) AS guild_id,
         MAX(COALESCE(c.normalized_url, c.content_url)) AS display_url,
         MAX(c.occurred_at_ms) AS occurred_at_ms
       FROM bot_provider_content_facets f
       JOIN bot_provider_content_events c ON c.content_event_id = f.content_event_id
       WHERE ${content.whereSql}
         AND f.facet_key IN (${placeholders})
       GROUP BY f.content_event_id, f.provider_id, f.account_key, f.facet_key, ${segmentValueSql}
     ) segment
     GROUP BY segment.provider_id, segment.account_key, segment.metric_key, segment.facet_value
     ORDER BY events DESC, users DESC, guilds DESC
     LIMIT ?`,
    ...content.params,
    ...metricParams,
    limit * 8,
  );

  const metricDefinitionCache = new Map<string, Map<string, { label: string; stage: string; required: boolean }>>();
  const decoratedRows = rows.flatMap((row) => {
    const provider = String(row.provider_id || "").toLowerCase();
    const metricKey = String(row.metric_key || "");
    const axes = axesByProviderMetric.get(`${provider}\x1f${metricKey}`) || [];
    if (!axes.length) return [];
    let metricDefinitions = metricDefinitionCache.get(provider);
    if (!metricDefinitions) {
      metricDefinitions = metricDefinitionsForProvider(provider);
      metricDefinitionCache.set(provider, metricDefinitions);
    }
    const metricDefinition = metricDefinitions.get(metricKey);
    const segmentScore = rowNumber(row, "events") + rowNumber(row, "users") * 4 + rowNumber(row, "guilds") * 3 + rowNumber(row, "urls") * 2;
    return axes.map((axis) => maskRow({
      ...row,
      axis_id: axis.id,
      axis_label: axis.label,
      metric_label: metricDefinition?.label || metricKey.split(".").slice(1).join(".") || metricKey,
      metric_stage: metricDefinition?.stage || "initial",
      metric_required: metricDefinition?.required || false,
      numeric_value_available: row.avg_numeric_value !== null && row.avg_numeric_value !== undefined,
      segment_score: segmentScore,
      analysis_model: "provider_specific_axis_segment",
    }));
  });

  return protectSmallGroupRows(
    decoratedRows
      .sort((left, right) => rowNumber(right, "segment_score") - rowNumber(left, "segment_score"))
      .slice(0, limit * 4),
  );
}

async function getDetailedFacetBreakdown(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const content = contentWhere(filters, window, "c", { includeFacetFilter: false });
  const facetKey = cleanFilter(filters.facetKey);
  const clauses = [content.whereSql];
  const params = [...content.params];
  if (facetKey) {
    clauses.push("f.facet_key = ?");
    params.push(facetKey);
  }
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       f.provider_id,
       f.account_key,
       f.facet_key,
       f.facet_value,
       COUNT(*) AS events,
       COUNT(DISTINCT c.author_user_id) AS users,
       COUNT(DISTINCT c.guild_id) AS guilds,
       AVG(f.numeric_value) AS avg_numeric_value,
       MIN(f.numeric_value) AS min_numeric_value,
       MAX(f.numeric_value) AS max_numeric_value
     FROM bot_provider_content_facets f
     JOIN bot_provider_content_events c ON c.content_event_id = f.content_event_id
     WHERE ${clauses.join(" AND ")}
     GROUP BY f.provider_id, f.account_key, f.facet_key, f.facet_value
     ORDER BY events DESC
     LIMIT ?`,
    ...params,
    limit,
  );
  return rows.map(maskRow);
}

async function getDetailedNumericFacetStats(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const content = contentWhere(filters, window, "c", { includeFacetFilter: false });
  const facetKey = cleanFilter(filters.facetKey);
  const clauses = [content.whereSql, "f.numeric_value IS NOT NULL"];
  const params = [...content.params];
  if (facetKey) {
    clauses.push("f.facet_key = ?");
    params.push(facetKey);
  }
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       f.provider_id,
       f.account_key,
       f.facet_key,
       COUNT(*) AS events,
       COUNT(DISTINCT c.author_user_id) AS users,
       COUNT(DISTINCT c.guild_id) AS guilds,
       AVG(f.numeric_value) AS avg_value,
       MIN(f.numeric_value) AS min_value,
       MAX(f.numeric_value) AS max_value,
       SUM(f.numeric_value) AS sum_value
     FROM bot_provider_content_facets f
     JOIN bot_provider_content_events c ON c.content_event_id = f.content_event_id
     WHERE ${clauses.join(" AND ")}
     GROUP BY f.provider_id, f.account_key, f.facet_key
     ORDER BY events DESC
     LIMIT ?`,
    ...params,
    limit,
  );
  return rows.map(maskRow);
}

async function getProviderMetricObservedRows(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }) {
  const content = contentWhere(filters, window, "c", { includeFacetFilter: false });
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       f.provider_id,
       f.facet_key,
       COUNT(*) AS events,
       COUNT(DISTINCT c.author_user_id) AS users,
       COUNT(DISTINCT c.guild_id) AS guilds,
       AVG(f.numeric_value) AS avg_value,
       SUM(f.numeric_value) AS sum_value
     FROM bot_provider_content_facets f
     JOIN bot_provider_content_events c ON c.content_event_id = f.content_event_id
     WHERE ${content.whereSql}
       AND f.facet_key IS NOT NULL
     GROUP BY f.provider_id, f.facet_key
     ORDER BY events DESC
     LIMIT 1000`,
    ...content.params,
  );
  return rows.map(maskRow);
}

async function getDetailedGuildAccountMatrix(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const content = contentWhere(filters, window);
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       c.provider_id,
       c.account_key,
       c.guild_id,
       COUNT(*) AS content_events,
       COUNT(DISTINCT c.author_user_id) AS users,
       COUNT(DISTINCT c.normalized_url) AS urls
     FROM bot_provider_content_events c
     WHERE ${content.whereSql}
       AND c.guild_id IS NOT NULL
     GROUP BY c.provider_id, c.account_key, c.guild_id
     ORDER BY content_events DESC
     LIMIT ?`,
    ...content.params,
    limit,
  );
  return rows.map(maskRow);
}

async function getDetailedHourDistribution(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const content = contentWhere(filters, window);
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       c.provider_id,
       c.account_key,
       FLOOR(MOD(FLOOR(c.occurred_at_ms / ?), 24)) AS hour_utc,
       COUNT(*) AS content_events,
       COUNT(DISTINCT c.author_user_id) AS users,
       COUNT(DISTINCT c.guild_id) AS guilds
     FROM bot_provider_content_events c
     WHERE ${content.whereSql}
     GROUP BY c.provider_id, c.account_key, hour_utc
     ORDER BY content_events DESC
     LIMIT ?`,
    HOUR_MS,
    ...content.params,
    limit,
  );
  return rows.map(maskRow);
}

async function getDetailedEventHourDistribution(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const analytics = analyticsWhere(filters, window);
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       a.provider_id,
       a.account_key,
       a.event_type,
       FLOOR(MOD(FLOOR(a.occurred_at_ms / ?), 24)) AS hour_utc,
       COUNT(*) AS events,
       SUM(a.success = 1) AS successes,
       SUM(a.success = 0) AS failures,
       AVG(a.duration_ms) AS avg_duration_ms
     FROM bot_analytics_events a
     WHERE ${analytics.whereSql}
     GROUP BY a.provider_id, a.account_key, a.event_type, hour_utc
     ORDER BY events DESC
     LIMIT ?`,
    HOUR_MS,
    ...analytics.params,
    limit,
  );
  return rows.map((row) => ({
    ...maskRow(row),
    success_rate: rate(row.successes, Number(row.successes || 0) + Number(row.failures || 0)),
  }));
}

async function getDetailedWeekdayDistribution(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const content = contentWhere(filters, window);
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       c.provider_id,
       c.account_key,
       DAYOFWEEK(FROM_UNIXTIME(c.occurred_at_ms / 1000)) AS weekday_utc,
       COUNT(*) AS content_events,
       COUNT(DISTINCT c.author_user_id) AS users,
       COUNT(DISTINCT c.guild_id) AS guilds,
       COUNT(DISTINCT c.normalized_url) AS urls
     FROM bot_provider_content_events c
     WHERE ${content.whereSql}
     GROUP BY c.provider_id, c.account_key, weekday_utc
     ORDER BY content_events DESC
     LIMIT ?`,
    ...content.params,
    limit,
  );
  return rows.map(maskRow);
}

async function getDetailedAudienceRetention(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }): Promise<Row> {
  const current = contentWhere(filters, window, "c");
  const previous = contentWhere(filters, { startMs: 0, endMs: Math.max(0, window.startMs - 1) }, "p");
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       COUNT(*) AS active_users,
       SUM(previous_users.author_user_id IS NULL) AS first_seen_users,
       SUM(previous_users.author_user_id IS NOT NULL) AS returning_users
     FROM (
       SELECT DISTINCT c.author_user_id
       FROM bot_provider_content_events c
       WHERE ${current.whereSql}
         AND c.author_user_id IS NOT NULL
     ) current_users
     LEFT JOIN (
       SELECT DISTINCT p.author_user_id
       FROM bot_provider_content_events p
       WHERE ${previous.whereSql}
         AND p.author_user_id IS NOT NULL
     ) previous_users
       ON previous_users.author_user_id = current_users.author_user_id`,
    ...current.params,
    ...previous.params,
  );
  const row = rows[0] || {};
  return {
    ...maskRow(row),
    returning_rate: rate(row.returning_users, row.active_users),
  };
}

async function getDetailedCommandBreakdown(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const analytics = analyticsWhere(filters, window);
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       a.event_type,
       COALESCE(a.command_name, a.component_id, a.endpoint_key, a.provider_id, 'unknown') AS action_key,
       COUNT(*) AS events,
       SUM(a.count) AS weighted_events,
       SUM(a.success = 1) AS successes,
       SUM(a.success = 0) AS failures,
       COUNT(DISTINCT a.author_user_id) AS users,
       COUNT(DISTINCT a.guild_id) AS guilds,
       AVG(a.duration_ms) AS avg_duration_ms
     FROM bot_analytics_events a
     WHERE ${analytics.whereSql}
     GROUP BY a.event_type, action_key
     ORDER BY events DESC
     LIMIT ?`,
    ...analytics.params,
    limit,
  );
  return rows.map((row) => ({
    ...maskRow(row),
    success_rate: rate(row.successes, Number(row.successes || 0) + Number(row.failures || 0)),
  }));
}

async function getDetailedInterestBreakdown(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const target = contentWhere(filters, window, "target");
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       target.provider_id AS target_provider_id,
       target.account_key AS target_account_key,
       other.provider_id AS interest_provider_id,
       other.account_key AS interest_account_key,
       other.content_type AS interest_content_type,
       COUNT(*) AS co_events,
       COUNT(DISTINCT target.author_user_id) AS shared_users,
       COUNT(DISTINCT target.guild_id) AS shared_guilds
     FROM bot_provider_content_events target
     JOIN bot_provider_content_events other
       ON other.author_user_id = target.author_user_id
      AND other.occurred_at_ms >= ?
      AND other.occurred_at_ms <= ?
     WHERE ${target.whereSql}
       AND target.author_user_id IS NOT NULL
       AND other.provider_id IS NOT NULL
       AND (
         other.provider_id <> target.provider_id
         OR COALESCE(other.account_key, '') <> COALESCE(target.account_key, '')
       )
     GROUP BY target.provider_id, target.account_key, other.provider_id, other.account_key, other.content_type
     ORDER BY co_events DESC
     LIMIT ?`,
    window.startMs,
    window.endMs,
    ...target.params,
    limit,
  );
  return rows.map(maskRow);
}

function errorWhere(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, alias = "e") {
  const clauses = [`${alias}.occurred_at_ms >= ?`, `${alias}.occurred_at_ms <= ?`];
  const params: unknown[] = [window.startMs, window.endMs];
  appendEquals(clauses, params, `${alias}.provider_id`, filters.providerId);
  appendEquals(clauses, params, `${alias}.guild_id`, filters.guildId);
  appendEquals(clauses, params, `${alias}.command_name`, filters.commandName);
  appendEquals(clauses, params, `${alias}.component_id`, filters.componentId);
  return { whereSql: clauses.join(" AND "), params };
}

async function getDetailedFailureReasons(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const errors = errorWhere(filters, window);
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       e.provider_id,
       e.source,
       e.error_type,
       e.severity,
       e.command_name,
       e.component_id,
       e.http_status,
       e.discord_code,
       COUNT(*) AS errors,
       COUNT(DISTINCT e.author_user_id) AS users,
       COUNT(DISTINCT e.guild_id) AS guilds,
       COUNT(DISTINCT e.url_hash) AS urls,
       COUNT(DISTINCT e.stack_hash) AS unique_stack_hashes,
       COUNT(DISTINCT e.message_hash) AS unique_message_hashes,
       MAX(e.occurred_at_ms) AS latest_ms
     FROM bot_error_events e
     WHERE ${errors.whereSql}
     GROUP BY e.provider_id, e.source, e.error_type, e.severity, e.command_name, e.component_id, e.http_status, e.discord_code
     ORDER BY errors DESC, latest_ms DESC
     LIMIT ?`,
    ...errors.params,
    limit,
  );
  return protectSmallGroupRows(rows.map((row) => ({
    ...maskRow(row),
    failure_scope: row.provider_id || row.command_name || row.component_id || row.source || "global",
    analysis_model: "failure_reason_summary",
  })));
}

async function getDetailedFunnelAnalytics(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const analytics = analyticsWhere({ ...filters, eventType: null }, window);
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       a.provider_id,
       a.account_key,
       SUM(a.event_type = 'provider_extract') AS url_posts,
       SUM(a.event_type = 'provider_extract' AND a.success = 1) AS extract_successes,
       SUM(a.event_type = 'provider_extract' AND a.success = 0) AS extract_failures,
       SUM(a.event_type = 'discord_send') AS send_attempts,
       SUM(a.event_type = 'discord_send' AND a.success = 1) AS send_successes,
       SUM(a.event_type = 'discord_send' AND a.success = 0) AS send_failures,
       SUM(a.event_type IN ('component', 'modal_submit')) AS interaction_events,
       SUM(a.event_type = 'media_delivery') AS media_delivery_requests,
       SUM(a.event_type = 'media_delivery' AND a.success = 1) AS media_delivery_successes,
       SUM(a.event_type = 'media_delivery' AND a.success = 0) AS media_delivery_failures,
       COUNT(DISTINCT a.author_user_id) AS users,
       COUNT(DISTINCT a.guild_id) AS guilds
     FROM bot_analytics_events a
     WHERE ${analytics.whereSql}
       AND a.provider_id IS NOT NULL
       AND a.event_type IN ('provider_extract', 'discord_send', 'component', 'modal_submit', 'media_delivery')
     GROUP BY a.provider_id, a.account_key
     ORDER BY url_posts DESC, interaction_events DESC
     LIMIT ?`,
    ...analytics.params,
    limit,
  );
  return protectSmallGroupRows(rows.map((row) => ({
    ...maskRow(row),
    extract_success_rate: rate(row.extract_successes, row.url_posts),
    send_success_rate: rate(row.send_successes, row.send_attempts),
    interaction_rate: rate(row.interaction_events, row.send_successes),
    media_delivery_rate: rate(row.media_delivery_successes, row.send_successes),
    analysis_model: "scoped_user_facing_funnel",
  })));
}

async function getDetailedWeeklyCohorts(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const allScope = contentWhere(filters, { startMs: 0, endMs: window.endMs }, "c_first");
  const allScopeForSizes = contentWhere(filters, { startMs: 0, endMs: window.endMs }, "c_size");
  const activity = contentWhere(filters, window, "c_activity");
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       cohorts.cohort_week_ms,
       activity.activity_week_ms,
       COUNT(DISTINCT activity.author_user_id) AS retained_users,
       cohort_sizes.cohort_users
     FROM (
       SELECT
         c_first.author_user_id,
         FLOOR(MIN(c_first.occurred_at_ms) / ?) * ? AS cohort_week_ms
       FROM bot_provider_content_events c_first
       WHERE ${allScope.whereSql}
         AND c_first.author_user_id IS NOT NULL
       GROUP BY c_first.author_user_id
     ) cohorts
     JOIN (
       SELECT first_seen.cohort_week_ms, COUNT(*) AS cohort_users
       FROM (
         SELECT
           c_size.author_user_id,
           FLOOR(MIN(c_size.occurred_at_ms) / ?) * ? AS cohort_week_ms
         FROM bot_provider_content_events c_size
         WHERE ${allScopeForSizes.whereSql}
           AND c_size.author_user_id IS NOT NULL
         GROUP BY c_size.author_user_id
       ) first_seen
       GROUP BY first_seen.cohort_week_ms
     ) cohort_sizes ON cohort_sizes.cohort_week_ms = cohorts.cohort_week_ms
     JOIN (
       SELECT
         c_activity.author_user_id,
         FLOOR(c_activity.occurred_at_ms / ?) * ? AS activity_week_ms
       FROM bot_provider_content_events c_activity
       WHERE ${activity.whereSql}
         AND c_activity.author_user_id IS NOT NULL
       GROUP BY c_activity.author_user_id, activity_week_ms
     ) activity ON activity.author_user_id = cohorts.author_user_id
     WHERE cohorts.cohort_week_ms >= ?
     GROUP BY cohorts.cohort_week_ms, activity.activity_week_ms, cohort_sizes.cohort_users
     ORDER BY cohorts.cohort_week_ms DESC, activity.activity_week_ms ASC
     LIMIT ?`,
    7 * DAY_MS,
    7 * DAY_MS,
    ...allScope.params,
    7 * DAY_MS,
    7 * DAY_MS,
    ...allScopeForSizes.params,
    7 * DAY_MS,
    7 * DAY_MS,
    ...activity.params,
    window.startMs - 8 * 7 * DAY_MS,
    limit,
  );
  return protectSmallGroupRows(rows.map((row) => ({
    ...maskRow(row),
    age_weeks: Math.max(0, Math.round((Number(row.activity_week_ms || 0) - Number(row.cohort_week_ms || 0)) / (7 * DAY_MS))),
    retention_rate: rate(row.retained_users, row.cohort_users),
    analysis_model: "scoped_user_facing_weekly_cohort",
  })));
}

async function getDetailedContentLifetime(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const content = contentWhere(filters, window);
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       c.provider_id,
       c.account_key,
       c.content_type,
       c.content_url,
       c.normalized_url,
       MAX(c.title) AS title,
       COUNT(*) AS content_events,
       COUNT(DISTINCT c.author_user_id) AS users,
       COUNT(DISTINCT c.guild_id) AS guilds,
       MIN(c.occurred_at_ms) AS first_seen_ms,
       MAX(c.occurred_at_ms) AS last_seen_ms
     FROM bot_provider_content_events c
     WHERE ${content.whereSql}
       AND (c.content_url IS NOT NULL OR c.normalized_url IS NOT NULL)
     GROUP BY c.provider_id, c.account_key, c.content_type, c.content_url, c.normalized_url
     HAVING content_events > 1 OR users > 1 OR guilds > 1
     ORDER BY (last_seen_ms - first_seen_ms) DESC, content_events DESC
     LIMIT ?`,
    ...content.params,
    limit,
  );
  return protectSmallGroupRows(rows.map((row) => ({
    ...maskRow(row),
    lifetime_hours: rate(Number(row.last_seen_ms || 0) - Number(row.first_seen_ms || 0), HOUR_MS),
    repeat_events: Math.max(0, rowNumber(row, "content_events") - 1),
    analysis_model: "scoped_user_facing_content_lifetime",
  })));
}

async function getDetailedUrlReuse(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const content = contentWhere(filters, window);
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       c.provider_id,
       c.account_key,
       c.content_url,
       c.normalized_url,
       MAX(c.title) AS title,
       COUNT(*) AS content_events,
       COUNT(DISTINCT c.guild_id) AS guilds,
       COUNT(DISTINCT c.author_user_id) AS users,
       MIN(c.occurred_at_ms) AS first_seen_ms,
       MAX(c.occurred_at_ms) AS last_seen_ms
     FROM bot_provider_content_events c
     WHERE ${content.whereSql}
       AND (c.content_url IS NOT NULL OR c.normalized_url IS NOT NULL)
     GROUP BY c.provider_id, c.account_key, c.content_url, c.normalized_url
     HAVING content_events > 1 OR users > 1 OR guilds > 1
     ORDER BY guilds DESC, users DESC, content_events DESC
     LIMIT ?`,
    ...content.params,
    limit,
  );
  return protectSmallGroupRows(rows.map((row) => {
    const spreadDays = Math.max(1, rate(Number(row.last_seen_ms || 0) - Number(row.first_seen_ms || 0), DAY_MS));
    return {
      ...maskRow(row),
      spread_days: spreadDays,
      spread_velocity_per_day: rate(row.guilds, spreadDays),
      analysis_model: "scoped_user_facing_url_reuse",
    };
  }));
}

async function getDetailedSettingImpact(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const clauses = ["a.created_at >= ?", "a.created_at <= ?", "(a.provider_id IS NOT NULL OR a.guild_id IS NOT NULL)"];
  const params: unknown[] = [new Date(window.startMs), new Date(window.endMs)];
  appendEquals(clauses, params, "a.guild_id", filters.guildId);
  appendEquals(clauses, params, "a.provider_id", filters.providerId);
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       a.provider_id,
       COALESCE(a.setting_key, '__provider__') AS setting_key,
       a.action,
       COUNT(DISTINCT a.audit_log_id) AS changes,
       COUNT(DISTINCT a.guild_id) AS guilds,
       SUM((
         SELECT COUNT(*)
         FROM bot_provider_content_events c
         WHERE c.occurred_at_ms >= (UNIX_TIMESTAMP(a.created_at) * 1000) - ?
           AND c.occurred_at_ms < UNIX_TIMESTAMP(a.created_at) * 1000
           AND (a.guild_id IS NULL OR c.guild_id = a.guild_id)
           AND (a.provider_id IS NULL OR c.provider_id = a.provider_id)
       )) AS content_before,
       SUM((
         SELECT COUNT(*)
         FROM bot_provider_content_events c
         WHERE c.occurred_at_ms >= UNIX_TIMESTAMP(a.created_at) * 1000
           AND c.occurred_at_ms < (UNIX_TIMESTAMP(a.created_at) * 1000) + ?
           AND (a.guild_id IS NULL OR c.guild_id = a.guild_id)
           AND (a.provider_id IS NULL OR c.provider_id = a.provider_id)
       )) AS content_after,
       SUM((
         SELECT COUNT(DISTINCT c.author_user_id)
         FROM bot_provider_content_events c
         WHERE c.occurred_at_ms >= UNIX_TIMESTAMP(a.created_at) * 1000
           AND c.occurred_at_ms < (UNIX_TIMESTAMP(a.created_at) * 1000) + ?
           AND (a.guild_id IS NULL OR c.guild_id = a.guild_id)
           AND (a.provider_id IS NULL OR c.provider_id = a.provider_id)
       )) AS users_after
     FROM dashboard_audit_logs a
     WHERE ${clauses.join(" AND ")}
     GROUP BY a.provider_id, COALESCE(a.setting_key, '__provider__'), a.action
     ORDER BY content_after DESC, changes DESC
     LIMIT ?`,
    7 * DAY_MS,
    7 * DAY_MS,
    7 * DAY_MS,
    ...params,
    limit,
  );
  return protectSmallGroupRows(rows.map((row) => ({
    ...maskRow(row),
    absolute_change: rowNumber(row, "content_after") - rowNumber(row, "content_before"),
    change_rate: rate(rowNumber(row, "content_after") - rowNumber(row, "content_before"), row.content_before),
    attribution_window_days: 7,
    analysis_model: "scoped_user_facing_setting_impact",
  })));
}

async function getDetailedRawSamples(filters: AdminDetailedAnalyticsFilters, window: { startMs: number; endMs: number }, limit: number) {
  const content = contentWhere(filters, window);
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       c.content_event_id,
       c.occurred_at_ms,
       c.provider_id,
       c.account_key,
       c.content_id,
       c.content_type,
       c.content_url,
       c.normalized_url,
       c.title,
       c.author_name,
       c.media_count,
       c.duration_seconds,
       c.guild_id,
       c.channel_id,
       c.author_user_id,
       c.source
     FROM bot_provider_content_events c
     WHERE ${content.whereSql}
     ORDER BY c.occurred_at_ms DESC
     LIMIT ?`,
    ...content.params,
    limit,
  );
  return rows.map(maskRow);
}

function normalizeDetailedAnalyticsFilters(rawFilters: AdminDetailedAnalyticsFilters): AdminDetailedAnalyticsFilters {
  return {
    providerId: cleanFilter(rawFilters.providerId),
    accountKey: cleanFilter(rawFilters.accountKey),
    guildId: cleanFilter(rawFilters.guildId),
    authorUserId: cleanFilter(rawFilters.authorUserId),
    eventType: cleanFilter(rawFilters.eventType),
    commandName: cleanFilter(rawFilters.commandName),
    componentId: cleanFilter(rawFilters.componentId),
    contentType: cleanFilter(rawFilters.contentType),
    facetKey: cleanFilter(rawFilters.facetKey),
    dateFrom: rawFilters.dateFrom,
    dateTo: rawFilters.dateTo,
    bucket: cleanFilter(rawFilters.bucket),
    limit: rawFilters.limit,
  };
}

function detailedAnalyticsCacheKey(filters: AdminDetailedAnalyticsFilters) {
  return JSON.stringify({
    providerId: filters.providerId || null,
    accountKey: filters.accountKey || null,
    guildId: filters.guildId || null,
    authorUserId: filters.authorUserId || null,
    eventType: filters.eventType || null,
    commandName: filters.commandName || null,
    componentId: filters.componentId || null,
    contentType: filters.contentType || null,
    facetKey: filters.facetKey || null,
    dateFrom: cleanFilter(filters.dateFrom),
    dateTo: cleanFilter(filters.dateTo),
    bucket: filters.bucket || null,
    limit: limitValue(filters.limit, 50),
  });
}

function emptyAdminDetailedAnalyticsSnapshot(filters: AdminDetailedAnalyticsFilters) {
  const limit = limitValue(filters.limit, 50);
  const window = detailedAnalyticsWindow(filters);
  return clientSafe({
    generatedAt: new Date().toISOString(),
    durationMs: 0,
    filters: {
      providerId: filters.providerId,
      accountKey: filters.accountKey,
      guildId: filters.guildId,
      authorUserId: filters.authorUserId ? anonymizeIdentifier(filters.authorUserId, "author_user_id") : null,
      eventType: filters.eventType,
      commandName: filters.commandName,
      componentId: filters.componentId,
      contentType: filters.contentType,
      facetKey: filters.facetKey,
      limit,
    },
    window: previewWindowPayload(window),
    summary: { content: {}, analytics: { success_rate: 0 } },
    timeSeries: [],
    providerAccounts: [],
    providerReliability: [],
    contentTypes: [],
    guildBreakdown: [],
    userBreakdown: [],
    urlBreakdown: [],
    valueDrivers: [],
    urlParameterBreakdown: [],
    providerSegments: [],
    facetBreakdown: [],
    numericFacetStats: [],
    guildAccountMatrix: [],
    hourDistribution: [],
    eventHourDistribution: [],
    commandBreakdown: [],
    interestBreakdown: [],
    failureReasons: [],
    rawSamples: [],
  });
}

async function buildAdminDetailedAnalytics(filters: AdminDetailedAnalyticsFilters) {
  const startedAt = Date.now();
  const limit = limitValue(filters.limit, 50);
  const window = detailedAnalyticsWindow(filters);

  const [
    summary,
    timeSeries,
    providerAccounts,
    providerReliability,
    contentTypes,
    guildBreakdown,
    userBreakdown,
    urlBreakdown,
    valueDrivers,
    urlParameterBreakdown,
    providerSegments,
    facetBreakdown,
    numericFacetStats,
    guildAccountMatrix,
    hourDistribution,
    eventHourDistribution,
    commandBreakdown,
    interestBreakdown,
    failureReasons,
    rawSamples,
  ] = await runLimited([
    () => optionalQuery({ content: {}, analytics: { success_rate: 0 } }, () => getDetailedSummary(filters, window)),
    () => optionalQuery([], () => getDetailedTimeSeries(filters, window)),
    () => optionalQuery([], () => getDetailedProviderAccounts(filters, window, limit)),
    () => optionalQuery([], () => getDetailedProviderReliability(filters, window, limit)),
    () => optionalQuery([], () => getDetailedContentTypeBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedGuildBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedUserCohortBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedUrlBreakdown(filters, window, limit)),
    () => getDetailedValueDrivers(filters, window, limit),
    () => optionalQuery([], () => getDetailedUrlParameterBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedProviderMarketingSegments(filters, window, limit)),
    () => optionalQuery([], () => getDetailedFacetBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedNumericFacetStats(filters, window, limit)),
    () => optionalQuery([], () => getDetailedGuildAccountMatrix(filters, window, limit)),
    () => optionalQuery([], () => getDetailedHourDistribution(filters, window, limit)),
    () => optionalQuery([], () => getDetailedEventHourDistribution(filters, window, limit)),
    () => optionalQuery([], () => getDetailedCommandBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedInterestBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedFailureReasons(filters, window, limit)),
    () => optionalQuery([], () => getDetailedRawSamples(filters, window, limit)),
  ] as const);

  return clientSafe({
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    filters: {
      providerId: filters.providerId,
      accountKey: filters.accountKey,
      guildId: filters.guildId,
      authorUserId: filters.authorUserId ? anonymizeIdentifier(filters.authorUserId, "author_user_id") : null,
      eventType: filters.eventType,
      commandName: filters.commandName,
      componentId: filters.componentId,
      contentType: filters.contentType,
      facetKey: filters.facetKey,
      limit,
    },
    window: {
      startMs: window.startMs,
      endMs: window.endMs,
      startAt: new Date(window.startMs).toISOString(),
      endAt: new Date(window.endMs).toISOString(),
      bucketMs: window.bucketMs,
      bucket: window.bucketMs === DAY_MS ? "day" : "hour",
    },
    summary,
    timeSeries,
    providerAccounts,
    providerReliability,
    contentTypes,
    guildBreakdown,
    userBreakdown,
    urlBreakdown,
    valueDrivers,
    urlParameterBreakdown,
    providerSegments,
    facetBreakdown,
    numericFacetStats,
    guildAccountMatrix,
    hourDistribution,
    eventHourDistribution,
    commandBreakdown,
    interestBreakdown,
    failureReasons,
    rawSamples,
  });
}

type AdminDetailedAnalyticsSnapshot = Awaited<ReturnType<typeof buildAdminDetailedAnalytics>>;

type AdminDetailedAnalyticsCacheEntry = {
  filters: AdminDetailedAnalyticsFilters;
  snapshot: AdminDetailedAnalyticsSnapshot | null;
  updatedAtMs: number;
  lastAccessedAtMs: number;
  refreshPromise: Promise<AdminDetailedAnalyticsSnapshot> | null;
  persistentSnapshotLoaded: boolean;
};

type AdminDetailedAnalyticsCacheState = {
  entries: Map<string, AdminDetailedAnalyticsCacheEntry>;
  timer: ReturnType<typeof setInterval> | null;
};

const adminDetailedAnalyticsCacheState = ((globalThis as typeof globalThis & {
  __cbteAdminDetailedAnalyticsCache?: AdminDetailedAnalyticsCacheState;
}).__cbteAdminDetailedAnalyticsCache ??= {
  entries: new Map<string, AdminDetailedAnalyticsCacheEntry>(),
  timer: null,
});

function isActiveAnalyticsCacheEntry(entry: { lastAccessedAtMs: number }) {
  return Date.now() - entry.lastAccessedAtMs <= ADMIN_ANALYTICS_CACHE_ACTIVE_MS;
}

function shouldRefreshAnalyticsCacheEntry(entry: { updatedAtMs: number; refreshPromise: Promise<unknown> | null }) {
  if (entry.refreshPromise) return false;
  if (!entry.updatedAtMs) return true;
  return Date.now() - entry.updatedAtMs >= ADMIN_ANALYTICS_BATCH_INTERVAL_MS;
}

function pruneAnalyticsCacheEntries<Entry extends { lastAccessedAtMs: number; refreshPromise: Promise<unknown> | null }>(entries: Map<string, Entry>) {
  const removable = [...entries.entries()]
    .filter(([, entry]) => !entry.refreshPromise)
    .sort((left, right) => left[1].lastAccessedAtMs - right[1].lastAccessedAtMs);

  for (const [key, entry] of removable) {
    if (entries.size <= ADMIN_ANALYTICS_CACHE_MAX_ENTRIES && isActiveAnalyticsCacheEntry(entry)) break;
    entries.delete(key);
  }
}

function refreshNextActiveAnalyticsCacheEntry<Entry extends {
  lastAccessedAtMs: number;
  updatedAtMs: number;
  refreshPromise: Promise<unknown> | null;
}>(
  entries: Map<string, Entry>,
  refresh: (entry: Entry) => Promise<unknown>,
) {
  pruneAnalyticsCacheEntries(entries);
  const entry = [...entries.values()]
    .filter((item) => isActiveAnalyticsCacheEntry(item) && shouldRefreshAnalyticsCacheEntry(item))
    .sort((left, right) => left.updatedAtMs - right.updatedAtMs)[0];
  if (entry) void refresh(entry).catch(() => undefined);
}

function getAdminDetailedAnalyticsCacheEntry(filters: AdminDetailedAnalyticsFilters) {
  const key = detailedAnalyticsCacheKey(filters);
  let entry = adminDetailedAnalyticsCacheState.entries.get(key);
  if (!entry) {
    entry = {
      filters,
      snapshot: null,
      updatedAtMs: 0,
      lastAccessedAtMs: Date.now(),
      refreshPromise: null,
      persistentSnapshotLoaded: false,
    };
    adminDetailedAnalyticsCacheState.entries.set(key, entry);
  } else {
    entry.filters = filters;
    entry.lastAccessedAtMs = Date.now();
  }
  return entry;
}

function persistedReportSnapshotKey(reportType: string, key: string) {
  return createHash("sha256").update(`${reportType}:${key}`).digest("hex");
}

async function loadPersistedDetailedAnalyticsSnapshot(entry: AdminDetailedAnalyticsCacheEntry) {
  if (entry.persistentSnapshotLoaded) return;
  entry.persistentSnapshotLoaded = true;
  const snapshotKey = persistedReportSnapshotKey("detailed", detailedAnalyticsCacheKey(entry.filters));
  const rows = await optionalQuery<Array<{ payload_json: string; generated_at_ms: number }>>([], () => prisma.$queryRawUnsafe(
    `SELECT payload_json, generated_at_ms
     FROM bot_admin_report_snapshots
     WHERE report_type = ? AND snapshot_key = ? AND generated_at_ms >= ?
     LIMIT 1`,
    "detailed",
    snapshotKey,
    Date.now() - ADMIN_REPORT_SNAPSHOT_MAX_AGE_MS,
  ));
  const row = rows[0];
  if (!row?.payload_json) return;
  try {
    const snapshot = JSON.parse(row.payload_json) as AdminDetailedAnalyticsSnapshot;
    if (!snapshot || typeof snapshot !== "object") return;
    entry.snapshot = snapshot;
    entry.updatedAtMs = Number(row.generated_at_ms) || 0;
  } catch {
    // A malformed historical cache entry must never block report generation.
  }
}

async function persistDetailedAnalyticsSnapshot(entry: AdminDetailedAnalyticsCacheEntry, snapshot: AdminDetailedAnalyticsSnapshot) {
  const snapshotKey = persistedReportSnapshotKey("detailed", detailedAnalyticsCacheKey(entry.filters));
  await optionalQuery(undefined, () => prisma.$executeRawUnsafe(
    `INSERT INTO bot_admin_report_snapshots (report_type, snapshot_key, generated_at_ms, payload_json)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE generated_at_ms = VALUES(generated_at_ms), payload_json = VALUES(payload_json)`,
    "detailed",
    snapshotKey,
    Date.now(),
    JSON.stringify(snapshot),
  ));
}

function refreshAdminDetailedAnalyticsCacheEntry(entry: AdminDetailedAnalyticsCacheEntry) {
  if (!entry.refreshPromise) {
    entry.refreshPromise = enqueueAdminAnalyticsBuild(() => buildAdminDetailedAnalytics(entry.filters))
      .then((snapshot) => {
        entry.snapshot = snapshot;
        entry.updatedAtMs = Date.now();
        void persistDetailedAnalyticsSnapshot(entry, snapshot);
        return snapshot;
      })
      .finally(() => {
        entry.refreshPromise = null;
      });
  }
  return entry.refreshPromise;
}

function ensureAdminDetailedAnalyticsBatchRefresh() {
  if (adminDetailedAnalyticsCacheState.timer) return;
  const timer = setInterval(() => {
    refreshNextActiveAnalyticsCacheEntry(adminDetailedAnalyticsCacheState.entries, refreshAdminDetailedAnalyticsCacheEntry);
  }, ADMIN_ANALYTICS_BATCH_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  adminDetailedAnalyticsCacheState.timer = timer;
}

function withAdminDetailedAnalyticsCacheState(snapshot: AdminDetailedAnalyticsSnapshot, entry: AdminDetailedAnalyticsCacheEntry) {
  const updatedAtMs = entry.updatedAtMs || 0;
  return clientSafe({
    ...snapshot,
    cache: {
      updatedAt: updatedAtMs ? new Date(updatedAtMs).toISOString() : null,
      nextUpdateAt: updatedAtMs ? new Date(updatedAtMs + ADMIN_ANALYTICS_BATCH_INTERVAL_MS).toISOString() : null,
      refreshIntervalMs: ADMIN_ANALYTICS_BATCH_INTERVAL_MS,
      refreshing: Boolean(entry.refreshPromise) || !entry.snapshot,
      ready: Boolean(entry.snapshot),
    },
  });
}

export function warmAdminDetailedAnalyticsCache(rawFilters: AdminDetailedAnalyticsFilters = {}) {
  ensureAdminDetailedAnalyticsBatchRefresh();
  if (!shouldPrewarmAdminAnalyticsCache()) return;
  const filters = normalizeDetailedAnalyticsFilters(rawFilters);
  const entry = getAdminDetailedAnalyticsCacheEntry(filters);
  void loadPersistedDetailedAnalyticsSnapshot(entry)
    .then(() => refreshAdminDetailedAnalyticsCacheEntry(entry))
    .catch(() => undefined);
}

export async function getAdminDetailedAnalytics(
  rawFilters: AdminDetailedAnalyticsFilters,
  options: { forceRefresh?: boolean } = {},
) {
  ensureAdminDetailedAnalyticsBatchRefresh();
  const filters = normalizeDetailedAnalyticsFilters(rawFilters);
  const entry = getAdminDetailedAnalyticsCacheEntry(filters);

  await loadPersistedDetailedAnalyticsSnapshot(entry);

  if (options.forceRefresh || !entry.snapshot) {
    void refreshAdminDetailedAnalyticsCacheEntry(entry).catch(() => undefined);
  }

  if (!entry.snapshot) {
    return withAdminDetailedAnalyticsCacheState(emptyAdminDetailedAnalyticsSnapshot(filters), entry);
  }

  return withAdminDetailedAnalyticsCacheState(entry.snapshot, entry);
}

export type AdminGuildAnalyticsPreviewFilters = {
  guildId?: string | null;
  providerId?: string | null;
  accountKey?: string | null;
  contentType?: string | null;
  dateFrom?: string | number | null;
  dateTo?: string | number | null;
  bucket?: string | null;
  limit?: string | number | null;
  urlVisibility?: string | null;
};

export type AdminProviderMarketingPreviewFilters = {
  providerId?: string | null;
  accountKey?: string | null;
  guildId?: string | null;
  contentType?: string | null;
  facetKey?: string | null;
  dateFrom?: string | number | null;
  dateTo?: string | number | null;
  bucket?: string | null;
  limit?: string | number | null;
  urlVisibility?: string | null;
};

function previewWindowPayload(window: { startMs: number; endMs: number; bucketMs: number }) {
  return {
    startMs: window.startMs,
    endMs: window.endMs,
    startAt: new Date(window.startMs).toISOString(),
    endAt: new Date(window.endMs).toISOString(),
    bucketMs: window.bucketMs,
    bucket: window.bucketMs === DAY_MS ? "day" : "hour",
  };
}

function previewCard(label: string, value: unknown, detail?: unknown, tone?: string) {
  return { label, value: serialize(value), detail: serialize(detail), tone: tone || "default" };
}

function topCell(rows: Row[], key: string) {
  return rows[0]?.[key] ?? null;
}

function facetRows(rows: Row[], keys: string[]) {
  const wanted = new Set(keys);
  return rows.filter((row) => wanted.has(String(row.facet_key || "")));
}

function prefixedFacetRows(rows: Row[], prefix: string) {
  return rows.filter((row) => String(row.facet_key || "").startsWith(prefix));
}

function firstNumericFacet(rows: Row[], facetKey: string, valueKey = "sum_value") {
  const row = rows.find((item) => item.facet_key === facetKey);
  return row?.[valueKey] ?? row?.avg_value ?? row?.events ?? null;
}

function providerMetricCard(label: string, value: unknown, detail: unknown = null, tone = "default") {
  return previewCard(label, value, detail, tone);
}

type ProviderProfileSpec = {
  title: string;
  description: string;
  successCriteria: string[];
  cards: Array<{ label: string; facetKey: string; valueKey?: string; detail?: string; tone?: string }>;
  sections: Array<{ id: string; title: string; description: string; facetKeys: string[] }>;
};

type ProviderMetricStage = "initial" | "enriched" | "optional";
type ProviderMetricDefinition = {
  key: string;
  label: string;
  stage: ProviderMetricStage;
  required: boolean;
  appliesToContentTypes?: string[];
};
type ProviderMetricSchema = {
  schemaVersion: string;
  metrics: ProviderMetricDefinition[];
  facets: string[];
  facetContentTypes?: Record<string, string[]>;
  displayAxes: string[];
};
type ProviderMarketingAxisDefinition = {
  id: string;
  label: string;
  metricKeys: string[];
};

function cleanSchemaContentType(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function cleanSchemaContentTypes(values: string[] | undefined) {
  return [...new Set((values || []).map(cleanSchemaContentType).filter(Boolean))];
}

function schemaMetric(key: string, label: string, stage: ProviderMetricStage = "initial", required = true, appliesToContentTypes: string[] = []): ProviderMetricDefinition {
  return { key, label, stage, required, appliesToContentTypes: cleanSchemaContentTypes(appliesToContentTypes) };
}

const PROVIDER_MARKETING_PROFILE_SPECS: Record<string, ProviderProfileSpec> = {
  instagram: {
    title: "Instagram 固有マーケティング指標",
    description: "likes、comments、views、followers、hashtag、mention、media/type を中心に、投稿・リールの反応を見る profile です。",
    successCriteria: [
      "likes/comments/views/followers を数値 facet として収集できる",
      "hashtag/mention で興味・拡散文脈を見られる",
      "media/type で投稿種別ごとの反応を比較できる",
    ],
    cards: [
      { label: "likes 合計", facetKey: "instagram.likes", tone: "success" },
      { label: "comments 合計", facetKey: "instagram.comments" },
      { label: "views 合計", facetKey: "instagram.views" },
      { label: "上位 hashtag", facetKey: "instagram.hashtag", valueKey: "facet_value" },
    ],
    sections: [
      { id: "instagram_engagement", title: "Post / reel engagement", description: "likes、comments、views、followers の反応です。", facetKeys: ["instagram.likes", "instagram.comments", "instagram.views", "instagram.followers"] },
      { id: "instagram_topics", title: "Hashtag / mention", description: "投稿文脈に含まれる hashtag と mention です。", facetKeys: ["instagram.hashtag", "instagram.mention"] },
      { id: "instagram_context", title: "Location / audio", description: "位置情報と音源による文脈分析です。", facetKeys: ["instagram.location", "instagram.audio"] },
      { id: "instagram_format", title: "Media / type", description: "画像、動画、リールなど表示形式の軸です。", facetKeys: ["instagram.media", "instagram.type"] },
    ],
  },
  tiktok: {
    title: "TikTok 固有マーケティング指標",
    description: "plays、likes、comments、shares、duration、music、hashtag を中心に短尺動画の反応を見る profile です。",
    successCriteria: [
      "plays/likes/comments/shares を数値 facet として収集できる",
      "duration/music で動画の構成要素を見られる",
      "hashtag/mention で興味軸を追える",
    ],
    cards: [
      { label: "plays 合計", facetKey: "tiktok.plays", tone: "success" },
      { label: "likes 合計", facetKey: "tiktok.likes" },
      { label: "shares 合計", facetKey: "tiktok.shares" },
      { label: "上位 music", facetKey: "tiktok.music", valueKey: "facet_value" },
    ],
    sections: [
      { id: "tiktok_engagement", title: "Video engagement", description: "plays、likes、comments、shares の反応です。", facetKeys: ["tiktok.plays", "tiktok.likes", "tiktok.comments", "tiktok.shares"] },
      { id: "tiktok_creative", title: "Creative signals", description: "動画時間、音源、hashtag、photo/video などクリエイティブ要素です。", facetKeys: ["tiktok.duration_seconds", "tiktok.music", "tiktok.hashtag", "tiktok.mention", "tiktok.type"] },
    ],
  },
  github: {
    title: "GitHub 固有マーケティング指標",
    description: "stars、forks、watchers、issues、pull requests、language、license、topics で開発者関心を見る profile です。",
    successCriteria: [
      "stars/forks/watchers で関心と再利用意欲を見られる",
      "issues/pull_requests で開発活動量を見られる",
      "language/license/topics で技術セグメントを見られる",
    ],
    cards: [
      { label: "stars 合計", facetKey: "github.stars", tone: "success" },
      { label: "forks 合計", facetKey: "github.forks" },
      { label: "issues 合計", facetKey: "github.issues" },
      { label: "上位 language", facetKey: "github.language", valueKey: "facet_value" },
    ],
    sections: [
      { id: "github_interest", title: "Repository interest", description: "stars、forks、watchers による関心指標です。", facetKeys: ["github.stars", "github.forks", "github.watchers"] },
      { id: "github_activity", title: "Development activity", description: "issues、pull requests など開発活動の指標です。", facetKeys: ["github.issues", "github.pull_requests"] },
      { id: "github_segments", title: "Developer segments", description: "language、license、topics による技術セグメントです。", facetKeys: ["github.language", "github.license", "github.topics"] },
    ],
  },
  twitch: {
    title: "Twitch provider-specific marketing metrics",
    description: "Clip views/duration and channel live viewers/status/game are tracked from Twitch GraphQL payloads.",
    successCriteria: [
      "Clip views and duration are captured for clip URLs.",
      "Channel live_viewers and live_status are captured for channel URLs.",
      "Game/category and broadcaster/curator facets remain available without reading embed fields.",
    ],
    cards: [
      { label: "Live viewers", facetKey: "twitch.live_viewers", tone: "success" },
      { label: "Clip views", facetKey: "twitch.views" },
      { label: "Avg clip duration", facetKey: "twitch.duration_seconds", valueKey: "avg_value" },
      { label: "Top game", facetKey: "twitch.game", valueKey: "facet_value" },
    ],
    sections: [
      { id: "twitch_reach", title: "Clip and live reach", description: "Clip views, live viewers, and clip duration from Twitch payloads.", facetKeys: ["twitch.views", "twitch.live_viewers", "twitch.duration_seconds"] },
      { id: "twitch_context", title: "Stream context", description: "Game/category, live status, broadcaster, and clip/channel type context.", facetKeys: ["twitch.game", "twitch.live_status", "twitch.type", "twitch.broadcaster", "twitch.broadcaster_login"] },
    ],
  },
  pixiv: {
    title: "pixiv 固有マーケティング指標",
    description: "views、bookmarks、likes、comments、tag、age restriction で作品反応を見る profile です。",
    successCriteria: [
      "views/bookmarks/likes/comments で作品反応を見られる",
      "tag で創作ジャンル・興味を見られる",
      "age_restricted で表示対象の注意軸を分けられる",
    ],
    cards: [
      { label: "views 合計", facetKey: "pixiv.views", tone: "success" },
      { label: "bookmarks 合計", facetKey: "pixiv.bookmarks" },
      { label: "likes 合計", facetKey: "pixiv.likes" },
      { label: "上位 tag", facetKey: "pixiv.tag", valueKey: "facet_value" },
    ],
    sections: [
      { id: "pixiv_artwork_response", title: "Artwork response", description: "views、bookmarks、likes、comments の反応です。", facetKeys: ["pixiv.views", "pixiv.bookmarks", "pixiv.likes", "pixiv.comments"] },
      { id: "pixiv_topics", title: "Tags / safety", description: "作品 tag、AI/R18、ugoira/page count の軸です。", facetKeys: ["pixiv.tag", "pixiv.age_restricted", "pixiv.ai_generated", "pixiv.type", "pixiv.page_count", "pixiv.ugoira_media_count"] },
    ],
  },
  niconico: {
    title: "ニコニコ固有マーケティング指標",
    description: "views、comments、mylists、likes、duration、category で動画反応を見る profile です。",
    successCriteria: [
      "views/comments/mylists/likes でニコニコ特有の反応を見られる",
      "duration で動画尺ごとの傾向を見られる",
      "category でジャンル別反応を見られる",
    ],
    cards: [
      { label: "views 合計", facetKey: "niconico.views", tone: "success" },
      { label: "comments 合計", facetKey: "niconico.comments" },
      { label: "mylists 合計", facetKey: "niconico.mylists" },
      { label: "平均動画秒数", facetKey: "niconico.duration_seconds", valueKey: "avg_value" },
    ],
    sections: [
      { id: "niconico_response", title: "Niconico response", description: "再生、コメント、マイリスト、いいねの反応です。", facetKeys: ["niconico.views", "niconico.comments", "niconico.mylists", "niconico.likes"] },
      { id: "niconico_video_context", title: "Video context", description: "動画時間、ジャンル、タグ、投稿者種別の軸です。", facetKeys: ["niconico.duration_seconds", "niconico.category", "niconico.genre", "niconico.tag", "niconico.uploader_type", "niconico.series"] },
    ],
  },
  booth: {
    title: "BOOTH 固有マーケティング指標",
    description: "price、favorites、stock status、category、shop で商品反応を見る profile です。",
    successCriteria: [
      "price/favorites で商品反応と価格帯を見られる",
      "stock_status で在庫状態による反応差を見られる",
      "category/shop で売り場・ジャンル別に比較できる",
    ],
    cards: [
      { label: "favorites 合計", facetKey: "booth.favorites", tone: "success" },
      { label: "平均価格", facetKey: "booth.price", valueKey: "avg_value" },
      { label: "在庫状態", facetKey: "booth.stock_status", valueKey: "facet_value" },
      { label: "上位カテゴリ", facetKey: "booth.category", valueKey: "facet_value" },
    ],
    sections: [
      { id: "booth_product_response", title: "Product response", description: "価格、お気に入り、在庫状態による商品反応です。", facetKeys: ["booth.price", "booth.favorites", "booth.stock_status"] },
      { id: "booth_merchandising", title: "Merchandising", description: "カテゴリ、ショップ、タグ、成人向け、販売状態ごとの反応です。", facetKeys: ["booth.category", "booth.shop", "booth.tag", "booth.adult", "booth.sale_status"] },
    ],
  },
  amazon: {
    title: "Amazon 固有マーケティング指標",
    description: "price、rating、reviews、availability、brand、category で商品反応を見る profile です。",
    successCriteria: [
      "price/rating/reviews で商品価値指標を見られる",
      "availability で在庫状態による反応差を見られる",
      "brand/category で購買関心を分類できる",
    ],
    cards: [
      { label: "平均価格", facetKey: "amazon.price", valueKey: "avg_value", tone: "success" },
      { label: "平均 rating", facetKey: "amazon.rating", valueKey: "avg_value" },
      { label: "reviews 合計", facetKey: "amazon.reviews" },
      { label: "上位 brand", facetKey: "amazon.brand", valueKey: "facet_value" },
    ],
    sections: [
      { id: "amazon_product_value", title: "Product value", description: "価格、評価、レビュー数による商品価値指標です。", facetKeys: ["amazon.price", "amazon.rating", "amazon.reviews"] },
      { id: "amazon_purchase_context", title: "Purchase context", description: "在庫、ブランド、カテゴリ、artist/album/genre/type の軸です。", facetKeys: ["amazon.availability", "amazon.brand", "amazon.category", "amazon.artist", "amazon.album", "amazon.genre", "amazon.type"] },
    ],
  },
  spotify: {
    title: "Spotify provider-specific marketing metrics",
    description: "Track/album/artist structure, duration, track count, preview availability, release label, and artist facets are tracked from Spotify entity data.",
    successCriteria: [
      "Track/album/artist type is captured for every Spotify URL.",
      "Duration, track_count, and preview availability are captured from entity data.",
      "Artist, album, explicit, and release_label facets are available without embed fields.",
    ],
    cards: [
      { label: "Avg duration", facetKey: "spotify.duration_seconds", valueKey: "avg_value", tone: "success" },
      { label: "Track count", facetKey: "spotify.track_count" },
      { label: "Preview available", facetKey: "spotify.preview_available" },
      { label: "Top type", facetKey: "spotify.type", valueKey: "facet_value" },
    ],
    sections: [
      { id: "spotify_audio_response", title: "Audio structure", description: "Duration, track count, preview availability, image availability, and track number.", facetKeys: ["spotify.duration_seconds", "spotify.track_count", "spotify.preview_available", "spotify.has_preview", "spotify.image_count", "spotify.track_number"] },
      { id: "spotify_catalog", title: "Catalog context", description: "Type, release label, artist, album, and explicit facets.", facetKeys: ["spotify.type", "spotify.release_label", "spotify.artist", "spotify.album", "spotify.explicit"] },
    ],
  },
  steam: {
    title: "Steam 固有マーケティング指標",
    description: "price、review count、rating、release label、genre でゲーム/アイテム反応を見る profile です。",
    successCriteria: [
      "price/review_count/rating でゲーム・商品価値を見られる",
      "release_label で発売時期の文脈を見られる",
      "genre でゲームジャンル別に比較できる",
    ],
    cards: [
      { label: "平均価格", facetKey: "steam.price", valueKey: "avg_value", tone: "success" },
      { label: "reviews 合計", facetKey: "steam.review_count" },
      { label: "平均 rating", facetKey: "steam.rating", valueKey: "avg_value" },
      { label: "上位 genre", facetKey: "steam.genre", valueKey: "facet_value" },
    ],
    sections: [
      { id: "steam_product_value", title: "Game / item value", description: "価格、割引、レビュー数、評価、現在プレイヤーの価値指標です。", facetKeys: ["steam.price", "steam.discount_percent", "steam.review_count", "steam.rating", "steam.current_players", "steam.recommendations"] },
      { id: "steam_catalog", title: "Catalog context", description: "発売時期、ジャンル、platform、developer/publisher の文脈です。", facetKeys: ["steam.release_label", "steam.genre", "steam.platform", "steam.developer", "steam.publisher", "steam.kind"] },
    ],
  },
};

const YOUTUBE_VIDEO_CONTENT_TYPES = ["video", "shorts", "live_video"];
const INSTAGRAM_MEDIA_CONTENT_TYPES = ["media", "video"];
const TIKTOK_CONTENT_TYPES = ["video", "photo"];
const TWITCH_CLIP_CONTENT_TYPES = ["clip"];
const TWITCH_CHANNEL_CONTENT_TYPES = ["channel"];
const SPOTIFY_AUDIO_CONTENT_TYPES = ["track", "album", "artist"];
const GITHUB_REPOSITORY_CONTENT_TYPES = ["repo", "repository"];
const STEAM_APP_CONTENT_TYPES = ["app"];
const AMAZON_PRODUCT_CONTENT_TYPES = ["product"];
const AMAZON_MEDIA_CONTENT_TYPES = ["music", "primeVideo", "prime_video"];

const PROVIDER_METRIC_SCHEMA_REGISTRY: Record<string, ProviderMetricSchema> = {
  twitter: {
    schemaVersion: "twitter.v1",
    metrics: [
      schemaMetric("twitter.likes", "Likes"),
      schemaMetric("twitter.reposts", "Reposts"),
      schemaMetric("twitter.replies", "Replies"),
      schemaMetric("twitter.media", "Media count", "optional", false),
    ],
    facets: ["twitter.hashtag", "twitter.mention", "twitter.media_type", "twitter.sensitive", "twitter.has_quote", "twitter.has_article"],
    displayAxes: ["engagement", "hashtags", "mentions", "media type", "quote/article", "safety"],
  },
  youtube: {
    schemaVersion: "youtube.v1",
    metrics: [
      schemaMetric("youtube.views", "Views"),
      schemaMetric("youtube.likes", "Likes", "optional", false, YOUTUBE_VIDEO_CONTENT_TYPES),
      schemaMetric("youtube.subscribers", "Subscribers", "optional", false, [...YOUTUBE_VIDEO_CONTENT_TYPES, "channel"]),
      schemaMetric("youtube.duration_seconds", "Duration seconds", "initial", true, YOUTUBE_VIDEO_CONTENT_TYPES),
      schemaMetric("youtube.video_count", "Playlist video count", "optional", false, ["playlist"]),
      schemaMetric("youtube.latest_video_count", "Channel latest video count", "optional", false, ["channel"]),
    ],
    facets: ["youtube.type", "youtube.date_label", "youtube.channel", "youtube.verified"],
    facetContentTypes: {
      "youtube.date_label": YOUTUBE_VIDEO_CONTENT_TYPES,
      "youtube.verified": ["channel"],
    },
    displayAxes: ["video performance", "shorts/video/live", "playlist/channel", "channel reach", "upload timing"],
  },
  instagram: {
    schemaVersion: "instagram.v1",
    metrics: [
      schemaMetric("instagram.likes", "Likes", "initial", true, INSTAGRAM_MEDIA_CONTENT_TYPES),
      schemaMetric("instagram.comments", "Comments", "initial", true, INSTAGRAM_MEDIA_CONTENT_TYPES),
      schemaMetric("instagram.views", "Views", "optional", false, INSTAGRAM_MEDIA_CONTENT_TYPES),
      schemaMetric("instagram.followers", "Followers", "optional", false),
      schemaMetric("instagram.following", "Following", "optional", false, ["profile"]),
      schemaMetric("instagram.posts", "Posts", "optional", false, ["profile"]),
      schemaMetric("instagram.media", "Media count", "optional", false, INSTAGRAM_MEDIA_CONTENT_TYPES),
      schemaMetric("instagram.duration_seconds", "Duration seconds", "optional", false, ["video"]),
    ],
    facets: ["instagram.hashtag", "instagram.mention", "instagram.media", "instagram.type", "instagram.location", "instagram.audio", "instagram.verified", "instagram.private", "instagram.has_external_url"],
    facetContentTypes: {
      "instagram.hashtag": INSTAGRAM_MEDIA_CONTENT_TYPES,
      "instagram.mention": INSTAGRAM_MEDIA_CONTENT_TYPES,
      "instagram.media": INSTAGRAM_MEDIA_CONTENT_TYPES,
      "instagram.location": INSTAGRAM_MEDIA_CONTENT_TYPES,
      "instagram.audio": INSTAGRAM_MEDIA_CONTENT_TYPES,
      "instagram.verified": ["profile"],
      "instagram.private": ["profile"],
      "instagram.has_external_url": ["profile"],
    },
    displayAxes: ["engagement", "hashtags", "mentions", "media type", "location/audio", "profile trust"],
  },
  tiktok: {
    schemaVersion: "tiktok.v1",
    metrics: [
      schemaMetric("tiktok.plays", "Plays", "initial", true, TIKTOK_CONTENT_TYPES),
      schemaMetric("tiktok.likes", "Likes"),
      schemaMetric("tiktok.comments", "Comments", "initial", true, TIKTOK_CONTENT_TYPES),
      schemaMetric("tiktok.shares", "Shares", "optional", false, TIKTOK_CONTENT_TYPES),
      schemaMetric("tiktok.duration_seconds", "Duration seconds", "optional", false, ["video"]),
      schemaMetric("tiktok.followers", "Followers", "optional", false, ["profile"]),
      schemaMetric("tiktok.following", "Following", "optional", false, ["profile"]),
      schemaMetric("tiktok.videos", "Videos", "optional", false, ["profile"]),
    ],
    facets: ["tiktok.music", "tiktok.hashtag", "tiktok.mention", "tiktok.type", "tiktok.verified"],
    facetContentTypes: {
      "tiktok.music": TIKTOK_CONTENT_TYPES,
      "tiktok.hashtag": TIKTOK_CONTENT_TYPES,
      "tiktok.mention": TIKTOK_CONTENT_TYPES,
      "tiktok.verified": ["profile"],
    },
    displayAxes: ["video reach", "engagement", "creative audio", "hashtags", "photo/video"],
  },
  github: {
    schemaVersion: "github.v1",
    metrics: [
      schemaMetric("github.stars", "Stars", "initial", true, GITHUB_REPOSITORY_CONTENT_TYPES),
      schemaMetric("github.forks", "Forks", "initial", true, GITHUB_REPOSITORY_CONTENT_TYPES),
      schemaMetric("github.watchers", "Watchers", "optional", false, GITHUB_REPOSITORY_CONTENT_TYPES),
      schemaMetric("github.issues", "Issues", "optional", false, [...GITHUB_REPOSITORY_CONTENT_TYPES, "issue"]),
      schemaMetric("github.pull_requests", "Pull requests", "optional", false, [...GITHUB_REPOSITORY_CONTENT_TYPES, "pull"]),
    ],
    facets: ["github.language", "github.license", "github.topics", "github.owner", "github.state", "github.type"],
    facetContentTypes: {
      "github.language": GITHUB_REPOSITORY_CONTENT_TYPES,
      "github.license": GITHUB_REPOSITORY_CONTENT_TYPES,
      "github.topics": GITHUB_REPOSITORY_CONTENT_TYPES,
      "github.state": ["issue", "pull"],
    },
    displayAxes: ["repository interest", "developer activity", "language", "license", "topics"],
  },
  twitch: {
    schemaVersion: "twitch.v1",
    metrics: [
      schemaMetric("twitch.views", "Clip views", "optional", false, TWITCH_CLIP_CONTENT_TYPES),
      schemaMetric("twitch.duration_seconds", "Clip duration", "optional", false, TWITCH_CLIP_CONTENT_TYPES),
      schemaMetric("twitch.live_viewers", "Live viewers", "optional", false, TWITCH_CHANNEL_CONTENT_TYPES),
      schemaMetric("twitch.video_url_available", "Video URL available", "optional", false, TWITCH_CLIP_CONTENT_TYPES),
    ],
    facets: ["twitch.game", "twitch.live_status", "twitch.type", "twitch.broadcaster", "twitch.broadcaster_login", "twitch.curator"],
    facetContentTypes: {
      "twitch.live_status": TWITCH_CHANNEL_CONTENT_TYPES,
      "twitch.curator": TWITCH_CLIP_CONTENT_TYPES,
    },
    displayAxes: ["clip reach", "live reach", "game/category", "channel status"],
  },
  pixiv: {
    schemaVersion: "pixiv.v1",
    metrics: [
      schemaMetric("pixiv.views", "Views"),
      schemaMetric("pixiv.bookmarks", "Bookmarks"),
      schemaMetric("pixiv.likes", "Likes", "optional", false),
      schemaMetric("pixiv.comments", "Comments", "optional", false),
      schemaMetric("pixiv.page_count", "Page count", "optional", false),
      schemaMetric("pixiv.ugoira_media_count", "Ugoira media count", "optional", false),
      schemaMetric("pixiv.ai_generated", "AI generated flag", "optional", false),
      schemaMetric("pixiv.x_restrict", "Age restriction level", "optional", false),
    ],
    facets: ["pixiv.tag", "pixiv.age_restricted", "pixiv.ai_generated", "pixiv.type"],
    displayAxes: ["artwork response", "tags", "AI/R18", "ugoira/page count", "format"],
  },
  niconico: {
    schemaVersion: "niconico.v1",
    metrics: [
      schemaMetric("niconico.views", "Views"),
      schemaMetric("niconico.comments", "Comments"),
      schemaMetric("niconico.mylists", "Mylists", "optional", false),
      schemaMetric("niconico.likes", "Likes", "optional", false),
      schemaMetric("niconico.duration_seconds", "Duration seconds", "optional", false),
    ],
    facets: ["niconico.category", "niconico.tag", "niconico.genre", "niconico.uploader_type", "niconico.series", "niconico.type"],
    displayAxes: ["video response", "comments", "duration", "category/genre", "tags", "uploader"],
  },
  booth: {
    schemaVersion: "booth.v1",
    metrics: [
      schemaMetric("booth.price", "Price"),
      schemaMetric("booth.favorites", "Favorites", "optional", false),
      schemaMetric("booth.variation_count", "Variation count", "optional", false),
    ],
    facets: ["booth.stock_status", "booth.category", "booth.shop", "booth.adult", "booth.sale_status", "booth.tag"],
    displayAxes: ["product value", "favorites", "availability", "shop/category", "sale/adult/tag"],
  },
  amazon: {
    schemaVersion: "amazon.v1",
    metrics: [
      schemaMetric("amazon.price", "Price", "optional", false, AMAZON_PRODUCT_CONTENT_TYPES),
      schemaMetric("amazon.rating", "Rating", "optional", false, AMAZON_PRODUCT_CONTENT_TYPES),
      schemaMetric("amazon.reviews", "Reviews", "optional", false, AMAZON_PRODUCT_CONTENT_TYPES),
      schemaMetric("amazon.duration_seconds", "Duration seconds", "optional", false, AMAZON_MEDIA_CONTENT_TYPES),
    ],
    facets: ["amazon.availability", "amazon.brand", "amazon.category", "amazon.artist", "amazon.album", "amazon.genre", "amazon.type"],
    facetContentTypes: {
      "amazon.availability": AMAZON_PRODUCT_CONTENT_TYPES,
      "amazon.brand": AMAZON_PRODUCT_CONTENT_TYPES,
      "amazon.artist": AMAZON_MEDIA_CONTENT_TYPES,
      "amazon.album": AMAZON_MEDIA_CONTENT_TYPES,
      "amazon.genre": AMAZON_MEDIA_CONTENT_TYPES,
    },
    displayAxes: ["product value", "reviews", "availability", "brand/category", "artist/album/genre"],
  },
  spotify: {
    schemaVersion: "spotify.v1",
    metrics: [
      schemaMetric("spotify.duration_seconds", "Duration seconds", "optional", false, ["track", "album"]),
      schemaMetric("spotify.image_count", "Image count", "optional", false, SPOTIFY_AUDIO_CONTENT_TYPES),
      schemaMetric("spotify.preview_available", "Preview available", "optional", false, ["track"]),
      schemaMetric("spotify.track_count", "Track count", "optional", false, ["track", "album", "artist"]),
      schemaMetric("spotify.track_number", "Track number", "optional", false, ["track"]),
    ],
    facets: ["spotify.preview_available", "spotify.has_preview", "spotify.type", "spotify.release_label", "spotify.artist", "spotify.album", "spotify.explicit"],
    facetContentTypes: {
      "spotify.preview_available": ["track"],
      "spotify.has_preview": ["track"],
      "spotify.album": ["track", "album"],
      "spotify.explicit": ["track"],
    },
    displayAxes: ["audio structure", "catalog type", "artist/album", "release", "preview availability"],
  },
  steam: {
    schemaVersion: "steam.v1",
    metrics: [
      schemaMetric("steam.price", "Price", "optional", false, STEAM_APP_CONTENT_TYPES),
      schemaMetric("steam.discount_percent", "Discount percent", "optional", false, STEAM_APP_CONTENT_TYPES),
      schemaMetric("steam.recommendations", "Recommendations", "optional", false, STEAM_APP_CONTENT_TYPES),
      schemaMetric("steam.current_players", "Current players", "enriched", false, STEAM_APP_CONTENT_TYPES),
      schemaMetric("steam.review_count", "Review count", "enriched", false, STEAM_APP_CONTENT_TYPES),
      schemaMetric("steam.rating", "Metacritic rating", "optional", false, STEAM_APP_CONTENT_TYPES),
    ],
    facets: ["steam.review_summary", "steam.release_label", "steam.genre", "steam.platform", "steam.developer", "steam.publisher", "steam.kind", "steam.type", "steam.price_label"],
    facetContentTypes: {
      "steam.review_summary": STEAM_APP_CONTENT_TYPES,
      "steam.release_label": STEAM_APP_CONTENT_TYPES,
      "steam.genre": STEAM_APP_CONTENT_TYPES,
      "steam.platform": STEAM_APP_CONTENT_TYPES,
      "steam.developer": STEAM_APP_CONTENT_TYPES,
      "steam.publisher": STEAM_APP_CONTENT_TYPES,
      "steam.price_label": STEAM_APP_CONTENT_TYPES,
    },
    displayAxes: ["game value", "review health", "current demand", "genre", "platform", "developer/publisher"],
  },
};

const PROVIDER_MARKETING_AXIS_SEGMENTS: Record<string, ProviderMarketingAxisDefinition[]> = {
  twitter: [
    { id: "engagement", label: "Engagement", metricKeys: ["twitter.likes", "twitter.reposts", "twitter.replies"] },
    { id: "media_type", label: "Media type", metricKeys: ["twitter.media", "twitter.media_type"] },
    { id: "hashtags_mentions", label: "Hashtags / mentions", metricKeys: ["twitter.hashtag", "twitter.mention"] },
    { id: "quote_article", label: "Quote / article", metricKeys: ["twitter.has_quote", "twitter.has_article"] },
    { id: "safety", label: "Safety", metricKeys: ["twitter.sensitive"] },
  ],
  youtube: [
    { id: "video_performance", label: "Video performance", metricKeys: ["youtube.views", "youtube.likes", "youtube.duration_seconds"] },
    { id: "format", label: "Shorts / video / live", metricKeys: ["youtube.type", "youtube.date_label"] },
    { id: "playlist_channel", label: "Playlist / channel", metricKeys: ["youtube.video_count", "youtube.latest_video_count", "youtube.channel", "youtube.verified"] },
    { id: "channel_reach", label: "Channel reach", metricKeys: ["youtube.subscribers"] },
  ],
  instagram: [
    { id: "engagement", label: "Engagement", metricKeys: ["instagram.likes", "instagram.comments", "instagram.views"] },
    { id: "hashtags_mentions", label: "Hashtags / mentions", metricKeys: ["instagram.hashtag", "instagram.mention"] },
    { id: "media_type", label: "Media type", metricKeys: ["instagram.media", "instagram.type", "instagram.duration_seconds"] },
    { id: "location_audio", label: "Location / audio", metricKeys: ["instagram.location", "instagram.audio"] },
    { id: "profile_trust", label: "Profile trust", metricKeys: ["instagram.followers", "instagram.following", "instagram.posts", "instagram.verified", "instagram.private", "instagram.has_external_url"] },
  ],
  tiktok: [
    { id: "video_reach", label: "Video reach", metricKeys: ["tiktok.plays", "tiktok.likes", "tiktok.comments", "tiktok.shares"] },
    { id: "creative_audio", label: "Creative audio", metricKeys: ["tiktok.duration_seconds", "tiktok.music"] },
    { id: "hashtags", label: "Hashtags", metricKeys: ["tiktok.hashtag", "tiktok.mention"] },
    { id: "photo_video", label: "Photo / video", metricKeys: ["tiktok.type"] },
    { id: "profile_context", label: "Profile context", metricKeys: ["tiktok.followers", "tiktok.following", "tiktok.videos", "tiktok.verified"] },
  ],
  github: [
    { id: "repository_interest", label: "Repository interest", metricKeys: ["github.stars", "github.forks", "github.watchers"] },
    { id: "developer_activity", label: "Developer activity", metricKeys: ["github.issues", "github.pull_requests", "github.state", "github.type"] },
    { id: "language_license", label: "Language / license", metricKeys: ["github.language", "github.license"] },
    { id: "topics_owner", label: "Topics / owner", metricKeys: ["github.topics", "github.owner"] },
  ],
  twitch: [
    { id: "clip_reach", label: "Clip reach", metricKeys: ["twitch.views", "twitch.duration_seconds", "twitch.video_url_available"] },
    { id: "live_reach", label: "Live reach", metricKeys: ["twitch.live_viewers", "twitch.live_status"] },
    { id: "game_category", label: "Game / category", metricKeys: ["twitch.game", "twitch.type"] },
    { id: "channel_status", label: "Channel status", metricKeys: ["twitch.broadcaster", "twitch.broadcaster_login", "twitch.curator"] },
  ],
  pixiv: [
    { id: "artwork_response", label: "Artwork response", metricKeys: ["pixiv.views", "pixiv.bookmarks", "pixiv.likes", "pixiv.comments"] },
    { id: "tags", label: "Tags", metricKeys: ["pixiv.tag"] },
    { id: "safety", label: "AI / R18", metricKeys: ["pixiv.ai_generated", "pixiv.age_restricted", "pixiv.x_restrict"] },
    { id: "format", label: "Ugoira / page count", metricKeys: ["pixiv.type", "pixiv.page_count", "pixiv.ugoira_media_count"] },
  ],
  niconico: [
    { id: "video_response", label: "Video response", metricKeys: ["niconico.views", "niconico.comments", "niconico.mylists", "niconico.likes"] },
    { id: "duration", label: "Duration", metricKeys: ["niconico.duration_seconds"] },
    { id: "genre_tags", label: "Genre / tags", metricKeys: ["niconico.category", "niconico.genre", "niconico.tag", "niconico.type"] },
    { id: "uploader_series", label: "Uploader / series", metricKeys: ["niconico.uploader_type", "niconico.series"] },
  ],
  booth: [
    { id: "product_value", label: "Product value", metricKeys: ["booth.price", "booth.favorites", "booth.variation_count"] },
    { id: "availability", label: "Availability", metricKeys: ["booth.stock_status", "booth.sale_status"] },
    { id: "shop_category", label: "Shop / category", metricKeys: ["booth.shop", "booth.category"] },
    { id: "sale_adult_tag", label: "Sale / adult / tag", metricKeys: ["booth.tag", "booth.adult"] },
  ],
  amazon: [
    { id: "product_value", label: "Product value", metricKeys: ["amazon.price", "amazon.rating", "amazon.reviews"] },
    { id: "availability", label: "Availability", metricKeys: ["amazon.availability"] },
    { id: "brand_category", label: "Brand / category", metricKeys: ["amazon.brand", "amazon.category"] },
    { id: "catalog_context", label: "Artist / album / genre", metricKeys: ["amazon.artist", "amazon.album", "amazon.genre", "amazon.type", "amazon.duration_seconds"] },
  ],
  spotify: [
    { id: "audio_structure", label: "Audio structure", metricKeys: ["spotify.duration_seconds", "spotify.track_count", "spotify.track_number"] },
    { id: "catalog_type", label: "Catalog type", metricKeys: ["spotify.type", "spotify.explicit"] },
    { id: "artist_album", label: "Artist / album", metricKeys: ["spotify.artist", "spotify.album"] },
    { id: "release_preview", label: "Release / preview", metricKeys: ["spotify.release_label", "spotify.preview_available", "spotify.has_preview", "spotify.image_count"] },
  ],
  steam: [
    { id: "game_value", label: "Game value", metricKeys: ["steam.price", "steam.discount_percent", "steam.recommendations"] },
    { id: "review_health", label: "Review health", metricKeys: ["steam.review_count", "steam.rating", "steam.review_summary"] },
    { id: "current_demand", label: "Current demand", metricKeys: ["steam.current_players"] },
    { id: "catalog_context", label: "Genre / platform / developer", metricKeys: ["steam.genre", "steam.platform", "steam.developer", "steam.publisher", "steam.kind", "steam.type", "steam.price_label", "steam.release_label"] },
  ],
};

function providerProfileRows(facetBreakdown: Row[], numericFacetStats: Row[], facetKeys: string[]) {
  return [
    ...facetRows(numericFacetStats, facetKeys),
    ...facetRows(facetBreakdown, facetKeys),
  ];
}

function providerMetricObservationRowKey(providerId: unknown, metricKey: unknown) {
  const provider = String(providerId || "").trim().toLowerCase();
  const key = String(metricKey || "").trim().toLowerCase();
  return provider && key ? `${provider}\u0001${key}` : "";
}

function observedMetricRows(facetBreakdown: Row[], numericFacetStats: Row[]) {
  const rows = new Map<string, Row>();
  for (const row of [...numericFacetStats, ...facetBreakdown]) {
    const key = providerMetricObservationRowKey(row.provider_id, row.facet_key);
    if (key && !rows.has(key)) rows.set(key, row);
  }
  return rows;
}

function schemaRowsForProvider(providerId: string, facetBreakdown: Row[], numericFacetStats: Row[]) {
  const schema = PROVIDER_METRIC_SCHEMA_REGISTRY[providerId];
  if (!schema) return [];
  const observed = observedMetricRows(facetBreakdown, numericFacetStats);
  return schema.metrics.map((metric) => {
    const row = observed.get(providerMetricObservationRowKey(providerId, metric.key));
    return {
      provider_id: providerId,
      schema_version: schema.schemaVersion,
      metric_key: metric.key,
      label: metric.label,
      stage: metric.stage,
      required: metric.required,
      applies_to_content_types: metric.appliesToContentTypes?.join(", ") || "all",
      coverage_status: row ? "observed" : metric.required ? "missing_required" : "not_observed",
      events: row?.events ?? row?.count ?? null,
      users: row?.users ?? row?.unique_users ?? null,
      avg_value: row?.avg_value ?? row?.avg_numeric_value ?? null,
      sum_value: row?.sum_value ?? row?.sum_numeric_value ?? null,
    };
  });
}

function providerMetricSchemaCoverage(providerId: unknown, facetBreakdown: Row[], numericFacetStats: Row[]) {
  const provider = String(providerId || "").trim().toLowerCase();
  if (!provider || !PROVIDER_METRIC_SCHEMA_REGISTRY[provider]) return [];
  return schemaRowsForProvider(provider, facetBreakdown, numericFacetStats);
}

function providerMetricSchemaSummary(providerId: unknown, facetBreakdown: Row[], numericFacetStats: Row[]) {
  const requestedProvider = String(providerId || "").trim().toLowerCase();
  const providers = requestedProvider && PROVIDER_METRIC_SCHEMA_REGISTRY[requestedProvider]
    ? [requestedProvider]
    : Object.keys(PROVIDER_METRIC_SCHEMA_REGISTRY);
  return providers.map((provider) => {
    const schema = PROVIDER_METRIC_SCHEMA_REGISTRY[provider];
    const rows = schemaRowsForProvider(provider, facetBreakdown, numericFacetStats);
    const requiredRows = rows.filter((row) => row.required);
    const enrichedRows = rows.filter((row) => row.stage === "enriched");
    const observedRows = rows.filter((row) => row.coverage_status === "observed");
    const observedRequiredRows = requiredRows.filter((row) => row.coverage_status === "observed");
    const observedEnrichedRows = enrichedRows.filter((row) => row.coverage_status === "observed");
    return {
      provider_id: provider,
      schema_version: schema.schemaVersion,
      total_metrics: rows.length,
      observed_metrics: observedRows.length,
      coverage_rate: rate(observedRows.length, rows.length),
      required_metrics: requiredRows.length,
      observed_required_metrics: observedRequiredRows.length,
      required_coverage_rate: rate(observedRequiredRows.length, requiredRows.length),
      enriched_metrics: enrichedRows.length,
      observed_enriched_metrics: observedEnrichedRows.length,
      enriched_coverage_rate: rate(observedEnrichedRows.length, enrichedRows.length),
      display_axes: schema.displayAxes.join(", "),
      collected_facets: schema.facets.join(", "),
    };
  });
}

const PROVIDER_METRIC_ALL_CONTENT_TYPES = "\u0000all";

function providerMetricContentTotalKey(providerId: string, contentType: string) {
  return `${providerId}\u0001${contentType}`;
}

function providerMetricObservedKey(providerId: string, metricKey: string, contentType: string) {
  return `${providerId}\u0001${metricKey}\u0001${contentType}`;
}

function sumProviderMetricContentEvents(contentTotals: Map<string, number>, providerId: string, appliesToContentTypes: string[]) {
  if (!appliesToContentTypes.length) return contentTotals.get(providerMetricContentTotalKey(providerId, PROVIDER_METRIC_ALL_CONTENT_TYPES)) || 0;
  return appliesToContentTypes.reduce(
    (sum, contentType) => sum + (contentTotals.get(providerMetricContentTotalKey(providerId, contentType)) || 0),
    0,
  );
}

function providerMetricObservedTotals(observed: Map<string, Row>, providerId: string, metricKey: string, appliesToContentTypes: string[]) {
  if (!appliesToContentTypes.length) {
    const row = observed.get(providerMetricObservedKey(providerId, metricKey, PROVIDER_METRIC_ALL_CONTENT_TYPES)) || {};
    return {
      observedEvents: rowNumber(row, "observed_events"),
      nullFacets: rowNumber(row, "null_facets"),
    };
  }
  return appliesToContentTypes.reduce((current, contentType) => {
    const row = observed.get(providerMetricObservedKey(providerId, metricKey, contentType)) || {};
    current.observedEvents += rowNumber(row, "observed_events");
    current.nullFacets += rowNumber(row, "null_facets");
    return current;
  }, { observedEvents: 0, nullFacets: 0 });
}

async function getProviderMetricNullRates(startMs: number) {
  const [contentRows, facetRowsRaw] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT provider_id, COALESCE(content_type, '') AS content_type, COUNT(*) AS content_events
       FROM bot_provider_content_events
       WHERE occurred_at_ms >= ?
         AND provider_id IS NOT NULL
       GROUP BY provider_id, content_type`,
      startMs,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         f.provider_id,
         f.facet_key,
         COALESCE(c.content_type, '') AS content_type,
         COUNT(*) AS facet_rows,
         COUNT(DISTINCT f.content_event_id) AS observed_events,
         SUM(f.facet_value IS NULL AND f.numeric_value IS NULL AND f.json_value IS NULL) AS null_facets
       FROM bot_provider_content_facets f
       JOIN bot_provider_content_events c ON c.content_event_id = f.content_event_id
       WHERE f.occurred_at_ms >= ?
       GROUP BY f.provider_id, f.facet_key, c.content_type`,
      startMs,
    ),
  ]);
  const contentTotals = new Map<string, number>();
  for (const row of contentRows) {
    const provider = String(row.provider_id || "").trim().toLowerCase();
    const contentType = cleanSchemaContentType(row.content_type);
    const count = Number(row.content_events || 0);
    if (provider && count > 0) {
      contentTotals.set(providerMetricContentTotalKey(provider, contentType), count);
      contentTotals.set(
        providerMetricContentTotalKey(provider, PROVIDER_METRIC_ALL_CONTENT_TYPES),
        (contentTotals.get(providerMetricContentTotalKey(provider, PROVIDER_METRIC_ALL_CONTENT_TYPES)) || 0) + count,
      );
    }
  }
  const observed = new Map<string, Row>();
  for (const row of facetRowsRaw) {
    const provider = String(row.provider_id || "").trim().toLowerCase();
    const metricKey = String(row.facet_key || "").trim().toLowerCase();
    const contentType = cleanSchemaContentType(row.content_type);
    if (!provider || !metricKey) continue;
    observed.set(providerMetricObservedKey(provider, metricKey, contentType), row);
    const aggregateKey = providerMetricObservedKey(provider, metricKey, PROVIDER_METRIC_ALL_CONTENT_TYPES);
    const current = observed.get(aggregateKey) || {};
    observed.set(aggregateKey, {
      ...row,
      content_type: "",
      facet_rows: rowNumber(current, "facet_rows") + rowNumber(row, "facet_rows"),
      observed_events: rowNumber(current, "observed_events") + rowNumber(row, "observed_events"),
      null_facets: rowNumber(current, "null_facets") + rowNumber(row, "null_facets"),
    });
  }

  const rows: Row[] = [];
  for (const [providerId, schema] of Object.entries(PROVIDER_METRIC_SCHEMA_REGISTRY)) {
    const providerContentEvents = sumProviderMetricContentEvents(contentTotals, providerId, []);
    if (providerContentEvents <= 0) continue;
    const expectedKeys = new Map<string, { stage: ProviderMetricStage | "facet"; required: boolean; label: string; appliesToContentTypes: string[] }>();
    for (const metric of schema.metrics) {
      expectedKeys.set(metric.key, {
        stage: metric.stage,
        required: metric.required,
        label: metric.label,
        appliesToContentTypes: cleanSchemaContentTypes(metric.appliesToContentTypes),
      });
    }
    for (const facetKey of schema.facets) {
      if (!expectedKeys.has(facetKey)) {
        expectedKeys.set(facetKey, {
          stage: "facet",
          required: false,
          label: facetKey,
          appliesToContentTypes: cleanSchemaContentTypes(schema.facetContentTypes?.[facetKey]),
        });
      }
    }
    for (const [metricKey, spec] of expectedKeys) {
      const contentEvents = sumProviderMetricContentEvents(contentTotals, providerId, spec.appliesToContentTypes);
      if (contentEvents <= 0) continue;
      const observedTotals = providerMetricObservedTotals(observed, providerId, metricKey, spec.appliesToContentTypes);
      const observedEvents = observedTotals.observedEvents;
      const nullFacets = Math.min(observedEvents, observedTotals.nullFacets);
      const presentEvents = Math.max(0, observedEvents - nullFacets);
      const nullOrMissingEvents = Math.max(0, contentEvents - presentEvents);
      rows.push({
        provider_id: providerId,
        schema_version: schema.schemaVersion,
        metric_key: metricKey,
        metric_label: spec.label,
        metric_stage: spec.stage,
        required: spec.required,
        applies_to_content_types: spec.appliesToContentTypes.length ? spec.appliesToContentTypes.join(", ") : "all",
        denominator_scope: spec.appliesToContentTypes.length ? "content_type" : "provider",
        provider_content_events: providerContentEvents,
        content_events: contentEvents,
        observed_events: observedEvents,
        present_events: presentEvents,
        null_or_missing_events: nullOrMissingEvents,
        coverage_rate: rate(presentEvents, contentEvents),
        null_rate: rate(nullOrMissingEvents, contentEvents),
      });
    }
  }
  return rows
    .sort((a, b) => Number(b.required || false) - Number(a.required || false) || Number(b.null_rate || 0) - Number(a.null_rate || 0))
    .slice(0, 160)
    .map(maskRow);
}

async function getProviderMetricObservationQuality(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       provider_id,
       account_key,
       metric_stage,
       COALESCE(schema_version, 'unknown') AS schema_version,
       COALESCE(metric_source, 'unknown') AS metric_source,
       COUNT(*) AS observations,
       SUM(collection_success = 1) AS successes,
       SUM(collection_success = 0) AS failures,
       SUM(collection_success IS NULL) AS unknown_results,
       AVG(GREATEST(0, COALESCE(collected_at_ms, occurred_at_ms) - occurred_at_ms)) AS avg_collection_delay_ms,
       MAX(GREATEST(0, COALESCE(collected_at_ms, occurred_at_ms) - occurred_at_ms)) AS max_collection_delay_ms,
       AVG(collection_timeout_ms) AS avg_timeout_ms,
       MAX(collection_timeout_ms) AS max_timeout_ms,
       MAX(occurred_at_ms) AS latest_ms
     FROM bot_provider_content_facets
     WHERE occurred_at_ms >= ?
     GROUP BY provider_id, account_key, metric_stage, schema_version, metric_source
     ORDER BY observations DESC
     LIMIT 160`,
    startMs,
  );
  return rows.map((row) => ({
    ...maskRow(row),
    success_rate: rate(row.successes, Number(row.successes || 0) + Number(row.failures || 0)),
    failure_rate: rate(row.failures, Number(row.successes || 0) + Number(row.failures || 0)),
  }));
}

function providerMetricRequired(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function getProviderRequiredMetricCoverage(metricNullRates: Row[]) {
  const providers = new Map<string, {
    provider_id: string;
    schema_version: unknown;
    required_metrics: number;
    observed_required_metrics: number;
    fully_missing_required_metrics: string[];
    weak_required_metrics: string[];
    expected_observations: number;
    present_observations: number;
    null_or_missing_observations: number;
  }>();

  for (const row of metricNullRates) {
    if (!providerMetricRequired(row.required)) continue;
    const providerId = String(row.provider_id || "").trim().toLowerCase();
    if (!providerId) continue;
    const current = providers.get(providerId) || {
      provider_id: providerId,
      schema_version: row.schema_version,
      required_metrics: 0,
      observed_required_metrics: 0,
      fully_missing_required_metrics: [],
      weak_required_metrics: [],
      expected_observations: 0,
      present_observations: 0,
      null_or_missing_observations: 0,
    };
    const contentEvents = rowNumber(row, "content_events");
    const presentEvents = rowNumber(row, "present_events");
    const nullOrMissingEvents = rowNumber(row, "null_or_missing_events");
    const coverageRate = rate(presentEvents, contentEvents);
    const metricKey = String(row.metric_key || "");
    current.required_metrics += 1;
    current.expected_observations += contentEvents;
    current.present_observations += presentEvents;
    current.null_or_missing_observations += nullOrMissingEvents;
    if (presentEvents > 0) current.observed_required_metrics += 1;
    if (metricKey && presentEvents <= 0) current.fully_missing_required_metrics.push(metricKey);
    else if (metricKey && coverageRate !== null && coverageRate < 0.95) current.weak_required_metrics.push(metricKey);
    providers.set(providerId, current);
  }

  return [...providers.values()].map((row) => {
    const status = row.fully_missing_required_metrics.length
      ? "missing_required_metrics"
      : row.weak_required_metrics.length
        ? "partial_required_coverage"
        : "healthy";
    return maskRow({
      provider_id: row.provider_id,
      schema_version: row.schema_version,
      status,
      required_metrics: row.required_metrics,
      observed_required_metrics: row.observed_required_metrics,
      missing_required_metrics: row.fully_missing_required_metrics.length,
      weak_required_metrics: row.weak_required_metrics.length,
      required_coverage_rate: rate(row.observed_required_metrics, row.required_metrics),
      observation_coverage_rate: rate(row.present_observations, row.expected_observations),
      null_or_missing_rate: rate(row.null_or_missing_observations, row.expected_observations),
      top_missing_metrics: row.fully_missing_required_metrics.slice(0, 8).join(", "),
      top_weak_metrics: row.weak_required_metrics.slice(0, 8).join(", "),
      recommended_action: status === "healthy" ? "monitor" : "fix provider analytics collection before exposing this provider report",
    });
  }).sort((a, b) => Number(b.missing_required_metrics || 0) - Number(a.missing_required_metrics || 0) || Number(b.null_or_missing_rate || 0) - Number(a.null_or_missing_rate || 0));
}

function expectedProviderMetricKeys(providerId: string) {
  const schema = PROVIDER_METRIC_SCHEMA_REGISTRY[providerId];
  if (!schema) return new Set<string>();
  return new Set([
    ...schema.metrics.map((metric) => metric.key),
    ...schema.facets,
  ]);
}

function isSystemAnalyticsFacet(key: string) {
  return key === "url.query_param";
}

async function getProviderMetricSchemaDrift(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       provider_id,
       facet_key,
       COALESCE(metric_stage, 'unknown') AS metric_stage,
       COALESCE(schema_version, 'unknown') AS schema_version,
       COALESCE(metric_source, 'unknown') AS metric_source,
       COUNT(*) AS observations,
       COUNT(DISTINCT content_event_id) AS observed_events,
       SUM(collection_success = 0) AS failed_observations,
       MAX(occurred_at_ms) AS latest_ms
     FROM bot_provider_content_facets
     WHERE occurred_at_ms >= ?
     GROUP BY provider_id, facet_key, metric_stage, schema_version, metric_source
     ORDER BY observations DESC
     LIMIT 500`,
    startMs,
  );

  return rows.flatMap((row) => {
    const providerId = String(row.provider_id || "").trim().toLowerCase();
    const facetKey = String(row.facet_key || "").trim().toLowerCase();
    if (!providerId || !facetKey || isSystemAnalyticsFacet(facetKey)) return [];
    const schema = PROVIDER_METRIC_SCHEMA_REGISTRY[providerId];
    const expectedKeys = expectedProviderMetricKeys(providerId);
    if (schema && expectedKeys.has(facetKey)) return [];
    return [maskRow({
      ...row,
      provider_id: providerId,
      facet_key: facetKey,
      registry_schema_version: schema?.schemaVersion || null,
      schema_status: schema ? "unregistered_observed_metric" : "unknown_provider",
      recommended_action: schema
        ? "add this metric/facet to provider schema registry or stop collecting it"
        : "create provider metric schema before exposing analytics",
    })];
  }).slice(0, 160);
}

async function getProviderEnrichmentSloDashboard(startMs: number) {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
       provider_id,
       account_key,
       source,
       COUNT(*) AS jobs,
       SUM(success = 1) AS successes,
       SUM(success = 0) AS failures,
       SUM(JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.outcome')) = 'timeout') AS timeout_jobs,
       SUM(JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.outcome')) = 'rate_limited') AS rate_limited_jobs,
       SUM(JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.outcome')) IN ('parse_failure', 'parse_failed', 'provider_parse_failed')) AS parse_failure_jobs,
       AVG(duration_ms) AS avg_duration_ms,
       MAX(duration_ms) AS max_duration_ms,
       AVG(CAST(JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.queue_wait_ms')) AS UNSIGNED)) AS avg_queue_wait_ms,
       MAX(CAST(JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.queue_wait_ms')) AS UNSIGNED)) AS max_queue_wait_ms,
       MAX(CAST(JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.retry_delay_ms')) AS UNSIGNED)) AS max_retry_delay_ms,
       SUM(COALESCE(duration_ms, 0) > COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.timeout_ms')) AS UNSIGNED), 30000)) AS duration_slo_breaches,
       SUM(COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(details_json, '$.queue_wait_ms')) AS UNSIGNED), 0) > 30000) AS queue_slo_breaches,
       MAX(occurred_at_ms) AS latest_ms
     FROM bot_analytics_events
     WHERE occurred_at_ms >= ?
       AND event_type = 'provider_analytics_enrichment'
     GROUP BY provider_id, account_key, source
     ORDER BY jobs DESC
     LIMIT 160`,
    startMs,
  );

  return rows.map((row) => {
    const jobs = rowNumber(row, "jobs");
    const breachJobs = Math.min(jobs, rowNumber(row, "duration_slo_breaches") + rowNumber(row, "queue_slo_breaches"));
    const timeoutJobs = rowNumber(row, "timeout_jobs");
    const rateLimitedJobs = rowNumber(row, "rate_limited_jobs");
    const status = timeoutJobs > 0
      ? "timeouts"
      : rateLimitedJobs > 0
        ? "rate_limited"
        : breachJobs > 0
          ? "latency_slo_breach"
          : "healthy";
    return maskRow({
      ...row,
      success_rate: rate(row.successes, Number(row.successes || 0) + Number(row.failures || 0)),
      failure_rate: rate(row.failures, Number(row.successes || 0) + Number(row.failures || 0)),
      slo_breach_jobs: breachJobs,
      slo_breach_rate: rate(breachJobs, jobs),
      status,
      recommended_action: status === "healthy" ? "monitor" : "check provider API latency, backoff, or enrichment timeout settings",
    });
  });
}

function providerProfileCard(spec: ProviderProfileSpec["cards"][number], facetBreakdown: Row[], numericFacetStats: Row[]) {
  const numericRow = numericFacetStats.find((row) => row.facet_key === spec.facetKey);
  const facetRow = facetBreakdown.find((row) => row.facet_key === spec.facetKey);
  const value = spec.valueKey
    ? numericRow?.[spec.valueKey] ?? facetRow?.[spec.valueKey]
    : numericRow?.sum_value ?? numericRow?.avg_value ?? facetRow?.facet_value ?? facetRow?.events ?? null;
  return providerMetricCard(spec.label, value, spec.detail || spec.facetKey, spec.tone || "default");
}

function configuredProviderMetricProfile(
  provider: string,
  accountKey: unknown,
  facetBreakdown: Row[],
  numericFacetStats: Row[],
  contentTypes: Row[],
) {
  const spec = PROVIDER_MARKETING_PROFILE_SPECS[provider];
  if (!spec) return null;
  return {
    mode: "provider_specific",
    providerId: provider,
    accountKey: accountKey || null,
    title: spec.title,
    description: spec.description,
    successCriteria: spec.successCriteria,
    cards: spec.cards.map((card) => providerProfileCard(card, facetBreakdown, numericFacetStats)),
    sections: spec.sections.map((section) => ({
      id: section.id,
      title: section.title,
      description: section.description,
      rows: providerProfileRows(facetBreakdown, numericFacetStats, section.facetKeys),
    })),
    sharedContext: { contentTypes },
  };
}

function providerMarketingMetricProfile(providerId: unknown, accountKey: unknown, facetBreakdown: Row[], numericFacetStats: Row[], contentTypes: Row[]) {
  const provider = String(providerId || "").trim().toLowerCase();
  if (!provider) {
    return {
      mode: "select_provider",
      providerId: null,
      accountKey: accountKey || null,
      title: "provider_id を指定すると provider 固有指標を表示します",
      description: "未指定時は provider ごとに意味が違うため、共通のマーケティング KPI としては扱わず、配信/利用の土台だけを比較します。",
      cards: [],
      sections: [],
      sharedContext: { contentTypes },
    };
  }

  const configured = configuredProviderMetricProfile(provider, accountKey, facetBreakdown, numericFacetStats, contentTypes);
  if (configured) return configured;

  const providerFacetRows = prefixedFacetRows(facetBreakdown, `${provider}.`);
  const providerNumericRows = prefixedFacetRows(numericFacetStats, `${provider}.`);
  const genericSections = [
    {
      id: "provider_fields",
      title: `${provider} で取得できたフィールド`,
      description: "provider 固有にまだ意味付けしていない embed field 由来の分析軸です。",
      rows: providerFacetRows,
    },
    {
      id: "provider_numeric_fields",
      title: `${provider} の数値フィールド`,
      description: "provider 固有にまだ意味付けしていない数値指標です。",
      rows: providerNumericRows,
    },
  ];

  if (provider === "twitter") {
    const engagementRows = facetRows(numericFacetStats, ["twitter.likes", "twitter.replies", "twitter.reposts", "twitter.media"]);
    const hashtagRows = facetRows(facetBreakdown, ["twitter.hashtag"]);
    const mentionRows = facetRows(facetBreakdown, ["twitter.mention"]);
    const sensitiveRows = facetRows(facetBreakdown, ["twitter.sensitive"]);
    const quoteArticleRows = facetRows(facetBreakdown, ["twitter.has_quote", "twitter.has_article", "twitter.media_type"]);
    return {
      mode: "provider_specific",
      providerId: provider,
      accountKey: accountKey || null,
      title: "Twitter / X 固有マーケティング指標",
      description: "likes、replies、reposts、hashtag、mention、media、sensitive など Twitter/X で意味を持つ軸だけを主指標にします。",
      cards: [
        providerMetricCard("推定 likes 合計", firstNumericFacet(numericFacetStats, "twitter.likes"), "twitter.likes", "success"),
        providerMetricCard("推定 reposts 合計", firstNumericFacet(numericFacetStats, "twitter.reposts"), "twitter.reposts"),
        providerMetricCard("推定 replies 合計", firstNumericFacet(numericFacetStats, "twitter.replies"), "twitter.replies"),
        providerMetricCard("上位 hashtag", topCell(hashtagRows, "facet_value"), topCell(hashtagRows, "events")),
      ],
      sections: [
        {
          id: "twitter_engagement",
          title: "Tweet engagement",
          description: "likes / reposts / replies / media など、Tweet で意味を持つ数値指標です。",
          rows: engagementRows,
        },
        {
          id: "twitter_hashtags",
          title: "Hashtag interests",
          description: "反応された Tweet に含まれる hashtag の分布です。",
          rows: hashtagRows,
        },
        {
          id: "twitter_mentions",
          title: "Mention network",
          description: "反応された Tweet に含まれる mention の分布です。",
          rows: mentionRows,
        },
        {
          id: "twitter_safety",
          title: "Sensitive / media signals",
          description: "sensitive や media など表示体験に関わる軸です。",
          rows: [...sensitiveRows, ...facetRows(numericFacetStats, ["twitter.media"])],
        },
        {
          id: "twitter_quote_article",
          title: "Quote / article signals",
          description: "quote repost, article card, and media type response signals.",
          rows: quoteArticleRows,
        },
      ],
      sharedContext: { contentTypes },
    };
  }

  if (provider === "youtube") {
    const performanceRows = facetRows(numericFacetStats, ["youtube.views", "youtube.likes", "youtube.subscribers", "youtube.duration_seconds"]);
    const typeRows = facetRows(facetBreakdown, ["youtube.type"]);
    const dateRows = facetRows(facetBreakdown, ["youtube.date_label"]);
    const channelRows = facetRows(facetBreakdown, ["youtube.channel", "youtube.verified"]);
    const playlistRows = facetRows(numericFacetStats, ["youtube.video_count", "youtube.latest_video_count"]);
    return {
      mode: "provider_specific",
      providerId: provider,
      accountKey: accountKey || null,
      title: "YouTube 固有マーケティング指標",
      description: "views、likes、subscribers、duration、動画種別など YouTube で意味を持つ軸だけを主指標にします。",
      cards: [
        providerMetricCard("推定 views 合計", firstNumericFacet(numericFacetStats, "youtube.views"), "youtube.views", "success"),
        providerMetricCard("推定 likes 合計", firstNumericFacet(numericFacetStats, "youtube.likes"), "youtube.likes"),
        providerMetricCard("購読者指標", firstNumericFacet(numericFacetStats, "youtube.subscribers"), "youtube.subscribers"),
        providerMetricCard("平均動画秒数", firstNumericFacet(numericFacetStats, "youtube.duration_seconds", "avg_value"), "youtube.duration_seconds"),
      ],
      sections: [
        {
          id: "youtube_performance",
          title: "Video performance",
          description: "views / likes / subscribers / duration など動画で意味を持つ数値指標です。",
          rows: performanceRows,
        },
        {
          id: "youtube_types",
          title: "Video type mix",
          description: "Shorts、通常動画、配信など type field 由来の分類です。",
          rows: typeRows,
        },
        {
          id: "youtube_date_labels",
          title: "Upload / update labels",
          description: "取得できた公開日・更新日ラベルの分布です。",
          rows: dateRows,
        },
        {
          id: "youtube_channel_playlist",
          title: "Channel / playlist context",
          description: "Channel, playlist video count, and channel latest-video context.",
          rows: [...channelRows, ...playlistRows],
        },
      ],
      sharedContext: { contentTypes },
    };
  }

  return {
    mode: "provider_generic",
    providerId: provider,
    accountKey: accountKey || null,
    title: `${provider} 固有フィールド分析`,
    description: "この provider はまだ専用 profile がないため、収集済み field/facet をそのまま分析軸として表示します。専用 profile を追加すると、この画面の主指標も provider 固有にできます。",
    cards: [
      providerMetricCard("取得 facet 種類", new Set(providerFacetRows.map((row) => row.facet_key)).size, "provider-specific facets"),
      providerMetricCard("数値 facet 種類", new Set(providerNumericRows.map((row) => row.facet_key)).size, "numeric facets"),
      providerMetricCard("上位 facet", topCell(providerFacetRows, "facet_key"), topCell(providerFacetRows, "events")),
    ],
    sections: genericSections,
    sharedContext: { contentTypes },
  };
}

function publicPreviewStatus(urlVisibility: PreviewUrlVisibility) {
  return {
    publicEnabled: false,
    adminPreviewOnly: true,
    rawDiscordMessagesStored: false,
    privacyMinGroupSize: PRIVACY_MIN_GROUP_SIZE,
    smallGroupsSuppressed: false,
    personalIdentifiers: "anonymized_or_hidden",
    channelIdentifiers: "not_exposed",
    messageIdentifiers: "not_exposed",
    rowLevelSamples: "disabled",
    rawUrlVisible: urlVisibility === "raw",
    normalizedUrlVisible: true,
    urlVisibility,
  };
}

function readinessStatusFromRate(value: unknown, healthy = 0.95, warning = 0.8) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "unknown";
  if (numeric >= healthy) return "ready";
  if (numeric >= warning) return "monitor";
  return "needs_attention";
}

function previewReadinessRow(check: string, status: string, evidence: string, recommendedAction: string, extra: Row = {}) {
  return {
    check,
    status,
    evidence,
    recommended_action: recommendedAction,
    ...extra,
  };
}

function finiteMetricValues(rows: Row[], key: string) {
  return rows
    .map((row) => Number(row[key]))
    .filter(Number.isFinite);
}

function minMetricValue(rows: Row[], key: string) {
  const values = finiteMetricValues(rows, key);
  return values.length ? Math.min(...values) : null;
}

function maxMetricValue(rows: Row[], key: string) {
  const values = finiteMetricValues(rows, key);
  return values.length ? Math.max(...values) : null;
}

function sumMetricValue(rows: Row[], key: string) {
  return rows.reduce((sum, row) => sum + rowNumber(row, key), 0);
}

function providerQualityStatus(row: Row) {
  const hasActivity = rowNumber(row, "content_events") > 0
    || rowNumber(row, "extract_events") > 0
    || rowNumber(row, "enrichment_jobs") > 0
    || rowNumber(row, "error_events") > 0;
  if (!hasActivity) return "no_data";
  if (rowNumber(row, "content_events") > 0 && rowNumber(row, "extract_events") <= 0) return "needs_attention";

  const requiredCoverage = Number(row.required_coverage_rate);
  if (Number.isFinite(requiredCoverage) && requiredCoverage < 1) return "schema_incomplete";

  const extractRate = Number(row.extract_success_rate);
  const enrichmentRate = Number(row.enrichment_success_rate);
  const errorRate = Number(row.error_rate);
  const hasEnrichmentJobs = rowNumber(row, "enrichment_jobs") > 0;
  if ((Number.isFinite(extractRate) && extractRate < 0.9)
    || (hasEnrichmentJobs && Number.isFinite(enrichmentRate) && enrichmentRate < 0.9)
    || (Number.isFinite(errorRate) && errorRate > 0.05)) {
    return "needs_attention";
  }
  if ((Number.isFinite(extractRate) && extractRate < 0.98)
    || (hasEnrichmentJobs && Number.isFinite(enrichmentRate) && enrichmentRate < 0.98)
    || (Number.isFinite(errorRate) && errorRate > 0.01)) {
    return "monitor";
  }
  return "ready";
}

function providerQualityRecommendedAction(status: string) {
  if (status === "ready") return "keep monitoring before enabling provider-facing access";
  if (status === "monitor") return "review reliability and schema trend before expanding access";
  if (status === "schema_incomplete") return "complete required provider metrics before release";
  if (status === "no_data") return "generate scoped provider activity before judging release readiness";
  return "fix provider extraction, enrichment, or data quality before release";
}

async function getProviderPreviewQualityGates(
  filters: AdminDetailedAnalyticsFilters,
  window: { startMs: number; endMs: number },
  metricSchemaSummary: Row[],
  limit: number,
) {
  const content = contentWhere(filters, window);
  const analytics = analyticsWhere({ ...filters, eventType: null }, window);
  const errors = errorWhere(filters, window);
  const queryLimit = Math.max(20, limit);
  const [contentRows, reliabilityRows, errorRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         c.provider_id,
         COUNT(*) AS content_events,
         COUNT(DISTINCT c.author_user_id) AS users,
         COUNT(DISTINCT c.guild_id) AS guilds,
         COUNT(DISTINCT c.normalized_url) AS urls
       FROM bot_provider_content_events c
       WHERE ${content.whereSql}
         AND c.provider_id IS NOT NULL
       GROUP BY c.provider_id
       ORDER BY content_events DESC
       LIMIT ?`,
      ...content.params,
      queryLimit,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         a.provider_id,
         SUM(a.event_type = 'provider_extract') AS extract_events,
         SUM(a.event_type = 'provider_extract' AND a.success = 1) AS extract_successes,
         SUM(a.event_type = 'provider_extract' AND a.success = 0) AS extract_failures,
         AVG(CASE WHEN a.event_type = 'provider_extract' THEN a.duration_ms ELSE NULL END) AS avg_extract_duration_ms,
         MAX(CASE WHEN a.event_type = 'provider_extract' THEN a.duration_ms ELSE NULL END) AS max_extract_duration_ms,
         SUM(a.event_type = 'provider_analytics_enrichment') AS enrichment_jobs,
         SUM(a.event_type = 'provider_analytics_enrichment' AND a.success = 1) AS enrichment_successes,
         SUM(a.event_type = 'provider_analytics_enrichment' AND a.success = 0) AS enrichment_failures,
         AVG(CASE WHEN a.event_type = 'provider_analytics_enrichment' THEN a.duration_ms ELSE NULL END) AS avg_enrichment_duration_ms,
         MAX(CASE WHEN a.event_type = 'provider_analytics_enrichment' THEN a.duration_ms ELSE NULL END) AS max_enrichment_duration_ms
       FROM bot_analytics_events a
       WHERE ${analytics.whereSql}
         AND a.provider_id IS NOT NULL
         AND a.event_type IN ('provider_extract', 'provider_analytics_enrichment')
       GROUP BY a.provider_id
       ORDER BY extract_events DESC, enrichment_jobs DESC
       LIMIT ?`,
      ...analytics.params,
      queryLimit,
    ),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT
         e.provider_id,
         e.error_type,
         e.severity,
         COUNT(*) AS errors
       FROM bot_error_events e
       WHERE ${errors.whereSql}
         AND e.provider_id IS NOT NULL
         AND (
           e.error_type LIKE 'provider_api_%'
           OR e.error_type LIKE 'provider_analytics_%'
           OR e.error_type IN ('provider_extract_error', 'provider_send_error')
         )
       GROUP BY e.provider_id, e.error_type, e.severity
       ORDER BY errors DESC
       LIMIT ?`,
      ...errors.params,
      queryLimit * 4,
    ),
  ]);

  const providers = new Map<string, Row>();
  const ensureProvider = (providerId: unknown) => {
    const provider = String(providerId || "").trim().toLowerCase();
    if (!provider) return null;
    const current = providers.get(provider) || { provider_id: provider };
    providers.set(provider, current);
    return current;
  };

  for (const row of contentRows) {
    const current = ensureProvider(row.provider_id);
    if (!current) continue;
    Object.assign(current, maskRow(row));
  }

  for (const row of reliabilityRows) {
    const current = ensureProvider(row.provider_id);
    if (!current) continue;
    Object.assign(current, maskRow({
      ...row,
      extract_success_rate: rowNumber(row, "extract_events") > 0
        ? rate(row.extract_successes, rowNumber(row, "extract_successes") + rowNumber(row, "extract_failures"))
        : null,
      enrichment_success_rate: rowNumber(row, "enrichment_jobs") > 0
        ? rate(row.enrichment_successes, rowNumber(row, "enrichment_successes") + rowNumber(row, "enrichment_failures"))
        : null,
    }));
  }

  const topErrors = new Map<string, Row>();
  for (const row of errorRows) {
    const provider = String(row.provider_id || "").trim().toLowerCase();
    if (!provider) continue;
    const current = ensureProvider(provider);
    if (!current) continue;
    current.error_events = rowNumber(current, "error_events") + rowNumber(row, "errors");
    const existing = topErrors.get(provider);
    if (!existing || rowNumber(row, "errors") > rowNumber(existing, "errors")) {
      topErrors.set(provider, maskRow(row));
    }
  }

  const requestedProvider = cleanFilter(filters.providerId)?.toLowerCase();
  for (const row of metricSchemaSummary) {
    const provider = String(row.provider_id || "").trim().toLowerCase();
    if (!provider || (!providers.has(provider) && requestedProvider !== provider)) continue;
    const current = ensureProvider(provider);
    if (!current) continue;
    Object.assign(current, {
      schema_version: row.schema_version,
      total_metrics: row.total_metrics,
      observed_metrics: row.observed_metrics,
      coverage_rate: row.coverage_rate,
      required_metrics: row.required_metrics,
      observed_required_metrics: row.observed_required_metrics,
      required_coverage_rate: row.required_coverage_rate,
      enriched_metrics: row.enriched_metrics,
      observed_enriched_metrics: row.observed_enriched_metrics,
      enriched_coverage_rate: row.enriched_coverage_rate,
    });
  }

  if (requestedProvider) ensureProvider(requestedProvider);

  const rows = [...providers.values()].map((row) => {
    const provider = String(row.provider_id || "").trim().toLowerCase();
    const topError = topErrors.get(provider);
    const activityEvents = rowNumber(row, "content_events") + rowNumber(row, "extract_events") + rowNumber(row, "enrichment_jobs");
    const errorEvents = rowNumber(row, "error_events");
    const errorRate = activityEvents > 0 ? rate(errorEvents, activityEvents) : errorEvents > 0 ? 1 : 0;
    const extractRate = Number(row.extract_success_rate);
    const enrichmentRate = Number(row.enrichment_success_rate);
    const requiredCoverage = Number(row.required_coverage_rate);
    const extractScore = Number.isFinite(extractRate) ? extractRate : rowNumber(row, "content_events") > 0 ? 0 : 1;
    const enrichmentScore = Number.isFinite(enrichmentRate) ? enrichmentRate : 1;
    const schemaScore = Number.isFinite(requiredCoverage) ? requiredCoverage : 1;
    const errorScore = clamp01(1 - errorRate);
    const readinessScore = Math.round(100 * clamp01((extractScore * 0.35) + (enrichmentScore * 0.2) + (schemaScore * 0.3) + (errorScore * 0.15)));
    const withScores = {
      ...row,
      error_events: errorEvents,
      error_rate: errorRate,
      top_error_type: topError?.error_type || null,
      top_error_severity: topError?.severity || null,
      readiness_score: readinessScore,
    };
    const status = providerQualityStatus(withScores);
    return {
      ...withScores,
      quality_status: status,
      recommended_action: providerQualityRecommendedAction(status),
    };
  });

  return protectUserFacingPreviewRows(rows)
    .sort((left, right) => rowNumber(right, "readiness_score") - rowNumber(left, "readiness_score"))
    .slice(0, limit);
}

function userFacingPreviewReadinessRows(
  audience: "guild_admin" | "provider_marketing",
  content: Row,
  analytics: Row,
  urlVisibility: PreviewUrlVisibility,
  metricSchemaSummary: Row[] = [],
  providerQualityGates: Row[] = [],
) {
  const users = rowNumber(content, "users");
  const guilds = rowNumber(content, "guilds");
  const contentEvents = rowNumber(content, "content_events");
  const successRate = analytics.success_rate;
  const sampleStatus = contentEvents <= 0
    ? "no_data"
    : users > 0 && users < PRIVACY_MIN_GROUP_SIZE
      ? "small_group_suppressed"
      : audience === "provider_marketing" && guilds > 0 && guilds < PRIVACY_MIN_GROUP_SIZE
        ? "small_group_suppressed"
        : "ready";

  const rows = [
    previewReadinessRow(
      "privacy_controls",
      "ready",
      "raw Discord messages are not stored; user, channel, and message identifiers are hidden or anonymized",
      "keep this report in admin preview until the user-facing product gate is enabled",
    ),
    previewReadinessRow(
      "small_group_privacy",
      sampleStatus,
      "rows below the privacy group threshold are suppressed before display",
      "do not expose exact low-count audience rows; keep aggregated percentages and grouped buckets",
      {
        users,
        guilds,
        content_events: contentEvents,
        privacy_min_group_size: PRIVACY_MIN_GROUP_SIZE,
      },
    ),
    previewReadinessRow(
      "url_visibility_policy",
      urlVisibility === "raw" ? "admin_raw_url_preview" : "normalized_url_default",
      urlVisibility === "raw" ? "raw URL with query is visible in admin preview only" : "normalized URL is the default user-facing view",
      "keep raw URL visibility permission-separated from normalized URL visibility",
    ),
    previewReadinessRow(
      "operational_success",
      readinessStatusFromRate(successRate),
      "provider extract, Discord send, and interaction success are aggregated without row-level samples",
      "investigate provider reliability before exposing the report if this is not ready",
      { success_rate: successRate },
    ),
  ];

  const providerQualityIds = new Set(providerQualityGates.map((row) => String(row.provider_id || "").trim().toLowerCase()).filter(Boolean));
  const schemaReadinessRows = audience === "provider_marketing" && providerQualityIds.size > 0
    ? metricSchemaSummary.filter((row) => providerQualityIds.has(String(row.provider_id || "").trim().toLowerCase()))
    : metricSchemaSummary;

  if (schemaReadinessRows.length) {
    const requiredRates = schemaReadinessRows
      .map((row) => Number(row.required_coverage_rate))
      .filter(Number.isFinite);
    const coverageRates = schemaReadinessRows
      .map((row) => Number(row.coverage_rate))
      .filter(Number.isFinite);
    const minRequiredCoverage = requiredRates.length ? Math.min(...requiredRates) : null;
    const minCoverage = coverageRates.length ? Math.min(...coverageRates) : null;
    rows.push(previewReadinessRow(
      "provider_metric_schema",
      minRequiredCoverage === null ? "unknown" : minRequiredCoverage >= 1 ? "ready" : "needs_attention",
      "provider-specific required metrics must be observed before provider-facing reports are exposed",
      "fix missing required metrics or keep this provider report in admin preview",
      {
        providers: schemaReadinessRows.length,
        min_required_coverage_rate: minRequiredCoverage,
        min_metric_coverage_rate: minCoverage,
      },
    ));
  }

  if (audience === "provider_marketing" && providerQualityGates.length) {
    const activeGates = providerQualityGates.filter((row) => row.quality_status !== "no_data");
    const extractEvents = sumMetricValue(providerQualityGates, "extract_events");
    const enrichmentJobs = sumMetricValue(providerQualityGates, "enrichment_jobs");
    const errorEvents = sumMetricValue(providerQualityGates, "error_events");
    const minExtractRate = minMetricValue(providerQualityGates.filter((row) => rowNumber(row, "extract_events") > 0), "extract_success_rate");
    const minEnrichmentRate = minMetricValue(providerQualityGates.filter((row) => rowNumber(row, "enrichment_jobs") > 0), "enrichment_success_rate");
    const maxErrorRate = maxMetricValue(providerQualityGates, "error_rate");
    const needsAttention = providerQualityGates.filter((row) => ["needs_attention", "schema_incomplete"].includes(String(row.quality_status))).length;
    const monitors = providerQualityGates.filter((row) => row.quality_status === "monitor").length;
    const ready = providerQualityGates.filter((row) => row.quality_status === "ready").length;
    const qualityStatus = activeGates.length === 0
      ? "no_data"
      : needsAttention > 0
        ? "needs_attention"
        : monitors > 0
          ? "monitor"
          : "ready";

    rows.push(previewReadinessRow(
      "provider_quality_gates",
      qualityStatus,
      "provider-level release gates are aggregated without row-level operational details",
      "fix every provider marked needs_attention before user-facing provider reports are enabled",
      {
        providers: providerQualityGates.length,
        ready_providers: ready,
        monitor_providers: monitors,
        providers_needing_attention: needsAttention,
      },
    ));

    rows.push(previewReadinessRow(
      "provider_extract_quality",
      extractEvents > 0 ? readinessStatusFromRate(minExtractRate, 0.98, 0.9) : "needs_attention",
      "provider extraction reliability is measured from provider-level analytics events",
      "restore extraction telemetry and success rate before releasing provider reports",
      {
        providers: providerQualityGates.length,
        events: extractEvents,
        min_extract_success_rate: minExtractRate,
      },
    ));

    rows.push(previewReadinessRow(
      "provider_enrichment_quality",
      enrichmentJobs > 0 ? readinessStatusFromRate(minEnrichmentRate, 0.98, 0.9) : "not_applicable",
      "async enrichment reliability is evaluated only when enrichment jobs exist in scope",
      "keep enriched metric schema coverage complete when enriched metrics are required",
      {
        providers: providerQualityGates.length,
        jobs: enrichmentJobs,
        min_enrichment_success_rate: minEnrichmentRate,
      },
    ));

    rows.push(previewReadinessRow(
      "provider_failure_pressure",
      activeGates.length === 0 ? "no_data" : (maxErrorRate ?? 0) <= 0.01 ? "ready" : (maxErrorRate ?? 0) <= 0.05 ? "monitor" : "needs_attention",
      "provider data errors are reduced to provider-level counts and rates",
      "clear high provider error pressure before exposing provider-facing reports",
      {
        providers: providerQualityGates.length,
        errors: errorEvents,
        max_error_rate: maxErrorRate,
      },
    ));
  }

  return protectUserFacingPreviewRows(rows);
}

function normalizeGuildAnalyticsPreviewFilters(rawFilters: AdminGuildAnalyticsPreviewFilters): AdminGuildAnalyticsPreviewFilters {
  return {
    guildId: cleanFilter(rawFilters.guildId),
    providerId: cleanFilter(rawFilters.providerId),
    accountKey: cleanFilter(rawFilters.accountKey),
    contentType: cleanFilter(rawFilters.contentType),
    dateFrom: rawFilters.dateFrom,
    dateTo: rawFilters.dateTo,
    bucket: cleanFilter(rawFilters.bucket),
    limit: rawFilters.limit,
    urlVisibility: previewUrlVisibility(rawFilters.urlVisibility),
  };
}

function normalizeProviderMarketingPreviewFilters(rawFilters: AdminProviderMarketingPreviewFilters): AdminProviderMarketingPreviewFilters {
  return {
    providerId: cleanFilter(rawFilters.providerId),
    accountKey: cleanFilter(rawFilters.accountKey),
    guildId: cleanFilter(rawFilters.guildId),
    contentType: cleanFilter(rawFilters.contentType),
    facetKey: cleanFilter(rawFilters.facetKey),
    dateFrom: rawFilters.dateFrom,
    dateTo: rawFilters.dateTo,
    bucket: cleanFilter(rawFilters.bucket),
    limit: rawFilters.limit,
    urlVisibility: previewUrlVisibility(rawFilters.urlVisibility),
  };
}

async function buildAdminGuildAnalyticsPreview(rawFilters: AdminGuildAnalyticsPreviewFilters) {
  const startedAt = Date.now();
  const urlVisibility = previewUrlVisibility(rawFilters.urlVisibility);
  const filters: AdminDetailedAnalyticsFilters = {
    guildId: cleanFilter(rawFilters.guildId),
    providerId: cleanFilter(rawFilters.providerId),
    accountKey: cleanFilter(rawFilters.accountKey),
    contentType: cleanFilter(rawFilters.contentType),
    dateFrom: rawFilters.dateFrom,
    dateTo: rawFilters.dateTo,
    bucket: cleanFilter(rawFilters.bucket),
    limit: rawFilters.limit,
  };
  const limit = limitValue(filters.limit, 40);
  const window = detailedAnalyticsWindow(filters);
  const comparisonFilters = { ...filters, guildId: null };

  const [
    summary,
    audienceRetention,
    timeSeries,
    providerAccounts,
    providerReliability,
    contentTypes,
    currentGuilds,
    peerGuilds,
    userBreakdown,
    urlBreakdown,
    valueDrivers,
    urlParameterBreakdown,
    providerSegments,
    facetBreakdown,
    numericFacetStats,
    hourDistribution,
    weekdayDistribution,
    commandBreakdown,
    interestBreakdown,
    failureReasons,
    funnelAnalytics,
    weeklyCohorts,
    contentLifetime,
    urlReuse,
    settingImpact,
  ] = await runLimited([
    () => optionalQuery({ content: {}, analytics: { success_rate: 0 } }, () => getDetailedSummary(filters, window)),
    () => optionalQuery({ active_users: 0, first_seen_users: 0, returning_users: 0, returning_rate: 0 }, () => getDetailedAudienceRetention(filters, window)),
    () => optionalQuery([], () => getDetailedTimeSeries(filters, window)),
    () => optionalQuery([], () => getDetailedProviderAccounts(filters, window, limit)),
    () => optionalQuery([], () => getDetailedProviderReliability(filters, window, limit)),
    () => optionalQuery([], () => getDetailedContentTypeBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedGuildBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedGuildBreakdown(comparisonFilters, window, limit)),
    () => optionalQuery([], () => getDetailedUserCohortBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedUrlBreakdown(filters, window, limit)),
    () => getDetailedValueDrivers(filters, window, limit),
    () => optionalQuery([], () => getDetailedUrlParameterBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedProviderMarketingSegments(filters, window, limit)),
    () => optionalQuery([], () => getDetailedFacetBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedNumericFacetStats(filters, window, limit)),
    () => optionalQuery([], () => getDetailedHourDistribution(filters, window, limit)),
    () => optionalQuery([], () => getDetailedWeekdayDistribution(filters, window, limit)),
    () => optionalQuery([], () => getDetailedCommandBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedInterestBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedFailureReasons(filters, window, limit)),
    () => getDetailedFunnelAnalytics(filters, window, limit),
    () => getDetailedWeeklyCohorts(filters, window, limit),
    () => getDetailedContentLifetime(filters, window, limit),
    () => getDetailedUrlReuse(filters, window, limit),
    () => getDetailedSettingImpact(filters, window, limit),
  ] as const);

  const content = protectUserFacingPreviewRow(summary.content || {});
  const analytics = protectUserFacingPreviewRow(summary.analytics || {});
  const protectedAudienceRetention = protectUserFacingPreviewRow(audienceRetention);
  const protectedProviderAccounts = protectUserFacingPreviewRows(providerAccounts);
  const protectedValueDrivers = applyPreviewUrlPolicyRows(protectUserFacingPreviewRows(valueDrivers), urlVisibility);
  const protectedUrlParameters = protectUserFacingPreviewRows(urlParameterBreakdown);
  const protectedProviderSegments = protectUserFacingPreviewRows(providerSegments);
  const protectedFunnelAnalytics = protectUserFacingPreviewRows(funnelAnalytics);
  const protectedWeeklyCohorts = protectUserFacingPreviewRows(weeklyCohorts);
  const protectedContentLifetime = applyPreviewUrlPolicyRows(protectUserFacingPreviewRows(contentLifetime), urlVisibility);
  const protectedUrlReuse = applyPreviewUrlPolicyRows(protectUserFacingPreviewRows(urlReuse), urlVisibility);
  const protectedSettingImpact = protectUserFacingPreviewRows(settingImpact);
  const reportReadiness = userFacingPreviewReadinessRows("guild_admin", content, analytics, urlVisibility);
  const cards = [
    previewCard("表示されたコンテンツ", content.content_events, "URL 展開や provider 出力の合計", "success"),
    previewCard("利用ユーザー", content.users, `${protectedAudienceRetention.returning_users || 0} 人がリピート`),
    previewCard("反応したサーバー", content.guilds, filters.guildId ? "指定サーバー内" : "全体"),
    previewCard("対象アカウント", content.accounts, topCell(protectedProviderAccounts, "account_key")),
    previewCard("成功率", analytics.success_rate, "抽出・送信・操作イベントの成功割合"),
    previewCard("平均処理時間", analytics.avg_duration_ms, "ms"),
  ];

  return clientSafe({
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    audience: "guild_admin",
    title: filters.guildId ? "サーバー統計プレビュー" : "サーバー統計 全体比較プレビュー",
    scopeLabel: filters.guildId ? `guild:${filters.guildId}` : "all-guilds",
    status: publicPreviewStatus(urlVisibility),
    filters: {
      guildId: filters.guildId,
      providerId: filters.providerId,
      accountKey: filters.accountKey,
      contentType: filters.contentType,
      limit,
      urlVisibility,
    },
    window: previewWindowPayload(window),
    cards,
    summary: { content, analytics },
    sections: {
      reportReadiness,
      timeSeries: protectUserFacingPreviewRows(timeSeries),
      providerAccounts: protectedProviderAccounts,
      providerReliability: protectUserFacingPreviewRows(providerReliability),
      contentTypes: protectUserFacingPreviewRows(contentTypes),
      currentGuilds: protectUserFacingPreviewRows(currentGuilds),
      peerGuilds: protectUserFacingPreviewRows(peerGuilds),
      activeUsers: protectUserFacingPreviewRows(userBreakdown),
      topContent: applyPreviewUrlPolicyRows(protectUserFacingPreviewRows(urlBreakdown), urlVisibility),
      valueDrivers: protectedValueDrivers,
      urlParameters: protectedUrlParameters,
      providerSegments: protectedProviderSegments,
      topics: protectUserFacingPreviewRows(facetBreakdown),
      numericSignals: protectUserFacingPreviewRows(numericFacetStats),
      bestHours: protectUserFacingPreviewRows(hourDistribution),
      bestWeekdays: protectUserFacingPreviewRows(weekdayDistribution),
      commandUsage: protectUserFacingPreviewRows(commandBreakdown),
      failureReasons: protectUserFacingPreviewRows(failureReasons),
      funnelAnalytics: protectedFunnelAnalytics,
      weeklyCohorts: protectedWeeklyCohorts,
      contentLifetime: protectedContentLifetime,
      urlReuse: protectedUrlReuse,
      settingImpact: protectedSettingImpact,
      audienceRetention: protectedAudienceRetention,
      audienceInterests: protectUserFacingPreviewRows(interestBreakdown),
      recentSamples: [],
    },
  });
}

async function buildAdminProviderMarketingPreview(rawFilters: AdminProviderMarketingPreviewFilters) {
  const startedAt = Date.now();
  const urlVisibility = previewUrlVisibility(rawFilters.urlVisibility);
  const filters: AdminDetailedAnalyticsFilters = {
    providerId: cleanFilter(rawFilters.providerId),
    accountKey: cleanFilter(rawFilters.accountKey),
    guildId: cleanFilter(rawFilters.guildId),
    contentType: cleanFilter(rawFilters.contentType),
    facetKey: cleanFilter(rawFilters.facetKey),
    dateFrom: rawFilters.dateFrom,
    dateTo: rawFilters.dateTo,
    bucket: cleanFilter(rawFilters.bucket),
    limit: rawFilters.limit,
  };
  const limit = limitValue(filters.limit, 40);
  const window = detailedAnalyticsWindow(filters);

  const [
    summary,
    audienceRetention,
    timeSeries,
    providerAccounts,
    providerReliability,
    contentTypes,
    guildBreakdown,
    userBreakdown,
    urlBreakdown,
    valueDrivers,
    urlParameterBreakdown,
    providerSegments,
    facetBreakdown,
    numericFacetStats,
    schemaObservedMetrics,
    hourDistribution,
    weekdayDistribution,
    commandBreakdown,
    interestBreakdown,
    failureReasons,
    funnelAnalytics,
    weeklyCohorts,
    contentLifetime,
    urlReuse,
  ] = await runLimited([
    () => optionalQuery({ content: {}, analytics: { success_rate: 0 } }, () => getDetailedSummary(filters, window)),
    () => optionalQuery({ active_users: 0, first_seen_users: 0, returning_users: 0, returning_rate: 0 }, () => getDetailedAudienceRetention(filters, window)),
    () => optionalQuery([], () => getDetailedTimeSeries(filters, window)),
    () => optionalQuery([], () => getDetailedProviderAccounts(filters, window, limit)),
    () => optionalQuery([], () => getDetailedProviderReliability(filters, window, limit)),
    () => optionalQuery([], () => getDetailedContentTypeBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedGuildBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedUserCohortBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedUrlBreakdown(filters, window, limit)),
    () => getDetailedValueDrivers(filters, window, limit),
    () => optionalQuery([], () => getDetailedUrlParameterBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedProviderMarketingSegments(filters, window, limit)),
    () => optionalQuery([], () => getDetailedFacetBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedNumericFacetStats(filters, window, limit)),
    () => optionalQuery([], () => getProviderMetricObservedRows(filters, window)),
    () => optionalQuery([], () => getDetailedHourDistribution(filters, window, limit)),
    () => optionalQuery([], () => getDetailedWeekdayDistribution(filters, window, limit)),
    () => optionalQuery([], () => getDetailedCommandBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedInterestBreakdown(filters, window, limit)),
    () => optionalQuery([], () => getDetailedFailureReasons(filters, window, limit)),
    () => getDetailedFunnelAnalytics(filters, window, limit),
    () => getDetailedWeeklyCohorts(filters, window, limit),
    () => getDetailedContentLifetime(filters, window, limit),
    () => getDetailedUrlReuse(filters, window, limit),
  ] as const);

  const content = protectUserFacingPreviewRow(summary.content || {});
  const analytics = protectUserFacingPreviewRow(summary.analytics || {});
  const protectedAudienceRetention = protectUserFacingPreviewRow(audienceRetention);
  const protectedProviderAccounts = protectUserFacingPreviewRows(providerAccounts);
  const protectedGuildBreakdown = protectUserFacingPreviewRows(guildBreakdown);
  const protectedContentTypes = protectUserFacingPreviewRows(contentTypes);
  const protectedCommandBreakdown = protectUserFacingPreviewRows(commandBreakdown);
  const protectedInterestBreakdown = protectUserFacingPreviewRows(interestBreakdown);
  const protectedFailureReasons = protectUserFacingPreviewRows(failureReasons);
  const protectedValueDrivers = applyPreviewUrlPolicyRows(protectUserFacingPreviewRows(valueDrivers), urlVisibility);
  const protectedUrlParameters = protectUserFacingPreviewRows(urlParameterBreakdown);
  const protectedProviderSegments = protectUserFacingPreviewRows(providerSegments);
  const protectedFacetBreakdown = protectUserFacingPreviewRows(facetBreakdown);
  const protectedNumericFacetStats = protectUserFacingPreviewRows(numericFacetStats);
  const protectedFunnelAnalytics = protectUserFacingPreviewRows(funnelAnalytics);
  const protectedWeeklyCohorts = protectUserFacingPreviewRows(weeklyCohorts);
  const protectedContentLifetime = applyPreviewUrlPolicyRows(protectUserFacingPreviewRows(contentLifetime), urlVisibility);
  const protectedUrlReuse = applyPreviewUrlPolicyRows(protectUserFacingPreviewRows(urlReuse), urlVisibility);
  const metricProfile = providerMarketingMetricProfile(filters.providerId, filters.accountKey, protectedFacetBreakdown, protectedNumericFacetStats, protectedContentTypes);
  const metricSchemaSummary = providerMetricSchemaSummary(filters.providerId, schemaObservedMetrics, schemaObservedMetrics);
  const metricSchemaCoverage = providerMetricSchemaCoverage(filters.providerId, schemaObservedMetrics, schemaObservedMetrics);
  const providerQualityGates = await optionalQuery([], () => getProviderPreviewQualityGates(filters, window, metricSchemaSummary, limit));
  const reportReadiness = userFacingPreviewReadinessRows("provider_marketing", content, analytics, urlVisibility, metricSchemaSummary, providerQualityGates);
  const deliveryContextCards = [
    previewCard("到達サーバー", content.guilds, topCell(protectedGuildBreakdown, "guild_id"), "muted"),
    previewCard("反応ユーザー", content.users, `${protectedAudienceRetention.returning_users || 0} 人が継続反応`, "muted"),
    previewCard("展開コンテンツ", content.content_events, `${content.urls || 0} URL`, "muted"),
    previewCard("対象アカウント", content.accounts, topCell(protectedProviderAccounts, "account_key"), "muted"),
    previewCard("処理成功率", analytics.success_rate, "インフラ上の成功割合", "muted"),
  ];

  return clientSafe({
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    audience: "provider_marketing",
    title: filters.providerId ? "プロバイダー マーケティング分析プレビュー" : "全プロバイダー マーケティング比較プレビュー",
    scopeLabel: [filters.providerId, filters.accountKey].filter(Boolean).join(":") || "all-providers",
    status: publicPreviewStatus(urlVisibility),
    filters: {
      providerId: filters.providerId,
      accountKey: filters.accountKey,
      guildId: filters.guildId,
      contentType: filters.contentType,
      facetKey: filters.facetKey,
      limit,
      urlVisibility,
    },
    window: previewWindowPayload(window),
    cards: metricProfile.cards,
    deliveryContextCards,
    metricProfile,
    summary: { content, analytics },
    sections: {
      reportReadiness,
      timeSeries: protectUserFacingPreviewRows(timeSeries),
      providerAccounts: protectedProviderAccounts,
      providerReliability: protectUserFacingPreviewRows(providerReliability),
      contentTypes: protectedContentTypes,
      reachByGuild: protectedGuildBreakdown,
      audienceUsers: protectUserFacingPreviewRows(userBreakdown),
      topContent: applyPreviewUrlPolicyRows(protectUserFacingPreviewRows(urlBreakdown), urlVisibility),
      valueDrivers: protectedValueDrivers,
      urlParameters: protectedUrlParameters,
      providerSegments: protectedProviderSegments,
      topics: protectedFacetBreakdown,
      numericSignals: protectedNumericFacetStats,
      bestHours: protectUserFacingPreviewRows(hourDistribution),
      bestWeekdays: protectUserFacingPreviewRows(weekdayDistribution),
      commandUsage: protectedCommandBreakdown,
      failureReasons: protectedFailureReasons,
      funnelAnalytics: protectedFunnelAnalytics,
      weeklyCohorts: protectedWeeklyCohorts,
      contentLifetime: protectedContentLifetime,
      urlReuse: protectedUrlReuse,
      audienceRetention: protectedAudienceRetention,
      audienceInterests: protectedInterestBreakdown,
      recentSamples: [],
      metricSchemaSummary,
      metricSchemaCoverage: protectUserFacingPreviewRows(metricSchemaCoverage),
      providerQualityGates,
    },
  });
}

type AdminGuildAnalyticsPreviewSnapshot = Awaited<ReturnType<typeof buildAdminGuildAnalyticsPreview>>;
type AdminProviderMarketingPreviewSnapshot = Awaited<ReturnType<typeof buildAdminProviderMarketingPreview>>;

type AdminPreviewCacheEntry<Filters, Snapshot> = {
  filters: Filters;
  snapshot: Snapshot | null;
  updatedAtMs: number;
  lastAccessedAtMs: number;
  refreshPromise: Promise<Snapshot> | null;
};

type AdminPreviewCacheState<Filters, Snapshot> = {
  entries: Map<string, AdminPreviewCacheEntry<Filters, Snapshot>>;
  timer: ReturnType<typeof setInterval> | null;
};

const adminGuildAnalyticsPreviewCacheState = ((globalThis as typeof globalThis & {
  __cbteAdminGuildAnalyticsPreviewCache?: AdminPreviewCacheState<AdminGuildAnalyticsPreviewFilters, AdminGuildAnalyticsPreviewSnapshot>;
}).__cbteAdminGuildAnalyticsPreviewCache ??= {
  entries: new Map<string, AdminPreviewCacheEntry<AdminGuildAnalyticsPreviewFilters, AdminGuildAnalyticsPreviewSnapshot>>(),
  timer: null,
});

const adminProviderMarketingPreviewCacheState = ((globalThis as typeof globalThis & {
  __cbteAdminProviderMarketingPreviewCache?: AdminPreviewCacheState<AdminProviderMarketingPreviewFilters, AdminProviderMarketingPreviewSnapshot>;
}).__cbteAdminProviderMarketingPreviewCache ??= {
  entries: new Map<string, AdminPreviewCacheEntry<AdminProviderMarketingPreviewFilters, AdminProviderMarketingPreviewSnapshot>>(),
  timer: null,
});

function previewCacheKey(filters: AdminGuildAnalyticsPreviewFilters | AdminProviderMarketingPreviewFilters) {
  return JSON.stringify({
    guildId: cleanFilter(filters.guildId),
    providerId: cleanFilter(filters.providerId),
    accountKey: cleanFilter(filters.accountKey),
    contentType: cleanFilter(filters.contentType),
    facetKey: "facetKey" in filters ? cleanFilter(filters.facetKey) : null,
    dateFrom: cleanFilter(filters.dateFrom),
    dateTo: cleanFilter(filters.dateTo),
    bucket: cleanFilter(filters.bucket),
    limit: limitValue(filters.limit, 40),
    urlVisibility: previewUrlVisibility(filters.urlVisibility),
  });
}

function emptyGuildAnalyticsPreviewSnapshot(rawFilters: AdminGuildAnalyticsPreviewFilters): AdminGuildAnalyticsPreviewSnapshot {
  const filters = normalizeGuildAnalyticsPreviewFilters(rawFilters);
  const urlVisibility = previewUrlVisibility(filters.urlVisibility);
  const details: AdminDetailedAnalyticsFilters = {
    guildId: cleanFilter(filters.guildId),
    providerId: cleanFilter(filters.providerId),
    accountKey: cleanFilter(filters.accountKey),
    contentType: cleanFilter(filters.contentType),
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    bucket: cleanFilter(filters.bucket),
    limit: filters.limit,
  };
  const limit = limitValue(filters.limit, 40);
  const window = detailedAnalyticsWindow(details);
  const content = {};
  const analytics = { success_rate: 0 };
  return clientSafe({
    generatedAt: new Date().toISOString(),
    durationMs: 0,
    audience: "guild_admin",
    title: details.guildId ? "サーバー統計プレビュー" : "サーバー統計 全体比較プレビュー",
    scopeLabel: details.guildId ? `guild:${details.guildId}` : "all-guilds",
    status: publicPreviewStatus(urlVisibility),
    filters: {
      guildId: details.guildId,
      providerId: details.providerId,
      accountKey: details.accountKey,
      contentType: details.contentType,
      limit,
      urlVisibility,
    },
    window: previewWindowPayload(window),
    cards: [],
    summary: { content, analytics },
    sections: {
      reportReadiness: userFacingPreviewReadinessRows("guild_admin", content, analytics, urlVisibility),
      timeSeries: [],
      providerAccounts: [],
      providerReliability: [],
      contentTypes: [],
      currentGuilds: [],
      peerGuilds: [],
      activeUsers: [],
      topContent: [],
      valueDrivers: [],
      urlParameters: [],
      providerSegments: [],
      topics: [],
      numericSignals: [],
      bestHours: [],
      bestWeekdays: [],
      commandUsage: [],
      failureReasons: [],
      funnelAnalytics: [],
      weeklyCohorts: [],
      contentLifetime: [],
      urlReuse: [],
      settingImpact: [],
      audienceRetention: {},
      audienceInterests: [],
      recentSamples: [],
    },
  }) as AdminGuildAnalyticsPreviewSnapshot;
}

function emptyProviderMarketingPreviewSnapshot(rawFilters: AdminProviderMarketingPreviewFilters): AdminProviderMarketingPreviewSnapshot {
  const filters = normalizeProviderMarketingPreviewFilters(rawFilters);
  const urlVisibility = previewUrlVisibility(filters.urlVisibility);
  const details: AdminDetailedAnalyticsFilters = {
    providerId: cleanFilter(filters.providerId),
    accountKey: cleanFilter(filters.accountKey),
    guildId: cleanFilter(filters.guildId),
    contentType: cleanFilter(filters.contentType),
    facetKey: cleanFilter(filters.facetKey),
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    bucket: cleanFilter(filters.bucket),
    limit: filters.limit,
  };
  const limit = limitValue(filters.limit, 40);
  const window = detailedAnalyticsWindow(details);
  const content = {};
  const analytics = { success_rate: 0 };
  const metricProfile = providerMarketingMetricProfile(details.providerId, details.accountKey, [], [], []);
  const metricSchemaSummary: Row[] = [];
  const providerQualityGates: Row[] = [];
  return clientSafe({
    generatedAt: new Date().toISOString(),
    durationMs: 0,
    audience: "provider_marketing",
    title: details.providerId ? "プロバイダー マーケティング分析プレビュー" : "全プロバイダー マーケティング比較プレビュー",
    scopeLabel: [details.providerId, details.accountKey].filter(Boolean).join(":") || "all-providers",
    status: publicPreviewStatus(urlVisibility),
    filters: {
      providerId: details.providerId,
      accountKey: details.accountKey,
      guildId: details.guildId,
      contentType: details.contentType,
      facetKey: details.facetKey,
      limit,
      urlVisibility,
    },
    window: previewWindowPayload(window),
    cards: metricProfile.cards,
    deliveryContextCards: [],
    metricProfile,
    summary: { content, analytics },
    sections: {
      reportReadiness: userFacingPreviewReadinessRows("provider_marketing", content, analytics, urlVisibility, metricSchemaSummary, providerQualityGates),
      timeSeries: [],
      providerAccounts: [],
      providerReliability: [],
      contentTypes: [],
      reachByGuild: [],
      audienceUsers: [],
      topContent: [],
      valueDrivers: [],
      urlParameters: [],
      providerSegments: [],
      topics: [],
      numericSignals: [],
      bestHours: [],
      bestWeekdays: [],
      commandUsage: [],
      failureReasons: [],
      funnelAnalytics: [],
      weeklyCohorts: [],
      contentLifetime: [],
      urlReuse: [],
      audienceRetention: {},
      audienceInterests: [],
      recentSamples: [],
      metricSchemaSummary,
      metricSchemaCoverage: [],
      providerQualityGates,
    },
  }) as unknown as AdminProviderMarketingPreviewSnapshot;
}

function getAdminPreviewCacheEntry<Filters, Snapshot>(
  state: AdminPreviewCacheState<Filters, Snapshot>,
  key: string,
  filters: Filters,
) {
  let entry = state.entries.get(key);
  if (!entry) {
    entry = {
      filters,
      snapshot: null,
      updatedAtMs: 0,
      lastAccessedAtMs: Date.now(),
      refreshPromise: null,
    };
    state.entries.set(key, entry);
  } else {
    entry.filters = filters;
    entry.lastAccessedAtMs = Date.now();
  }
  return entry;
}

function withAdminPreviewCacheState<Snapshot>(snapshot: Snapshot, entry: AdminPreviewCacheEntry<unknown, Snapshot>) {
  const updatedAtMs = entry.updatedAtMs || 0;
  return clientSafe({
    ...snapshot,
    cache: {
      updatedAt: updatedAtMs ? new Date(updatedAtMs).toISOString() : null,
      nextUpdateAt: updatedAtMs ? new Date(updatedAtMs + ADMIN_ANALYTICS_BATCH_INTERVAL_MS).toISOString() : null,
      refreshIntervalMs: ADMIN_ANALYTICS_BATCH_INTERVAL_MS,
      refreshing: Boolean(entry.refreshPromise) || !entry.snapshot,
      ready: Boolean(entry.snapshot),
    },
  });
}

function refreshAdminGuildAnalyticsPreviewCacheEntry(entry: AdminPreviewCacheEntry<AdminGuildAnalyticsPreviewFilters, AdminGuildAnalyticsPreviewSnapshot>) {
  if (!entry.refreshPromise) {
    entry.refreshPromise = enqueueAdminAnalyticsBuild(() => buildAdminGuildAnalyticsPreview(entry.filters))
      .then((snapshot) => {
        entry.snapshot = snapshot;
        entry.updatedAtMs = Date.now();
        return snapshot;
      })
      .finally(() => {
        entry.refreshPromise = null;
      });
  }
  return entry.refreshPromise;
}

function refreshAdminProviderMarketingPreviewCacheEntry(entry: AdminPreviewCacheEntry<AdminProviderMarketingPreviewFilters, AdminProviderMarketingPreviewSnapshot>) {
  if (!entry.refreshPromise) {
    entry.refreshPromise = enqueueAdminAnalyticsBuild(() => buildAdminProviderMarketingPreview(entry.filters))
      .then((snapshot) => {
        entry.snapshot = snapshot;
        entry.updatedAtMs = Date.now();
        return snapshot;
      })
      .finally(() => {
        entry.refreshPromise = null;
      });
  }
  return entry.refreshPromise;
}

function ensureAdminGuildAnalyticsPreviewBatchRefresh() {
  if (adminGuildAnalyticsPreviewCacheState.timer) return;
  const timer = setInterval(() => {
    refreshNextActiveAnalyticsCacheEntry(adminGuildAnalyticsPreviewCacheState.entries, refreshAdminGuildAnalyticsPreviewCacheEntry);
  }, ADMIN_ANALYTICS_BATCH_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  adminGuildAnalyticsPreviewCacheState.timer = timer;
}

function ensureAdminProviderMarketingPreviewBatchRefresh() {
  if (adminProviderMarketingPreviewCacheState.timer) return;
  const timer = setInterval(() => {
    refreshNextActiveAnalyticsCacheEntry(adminProviderMarketingPreviewCacheState.entries, refreshAdminProviderMarketingPreviewCacheEntry);
  }, ADMIN_ANALYTICS_BATCH_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  adminProviderMarketingPreviewCacheState.timer = timer;
}

export function warmAdminGuildAnalyticsPreviewCache(rawFilters: AdminGuildAnalyticsPreviewFilters = {}) {
  ensureAdminGuildAnalyticsPreviewBatchRefresh();
  if (!shouldPrewarmAdminAnalyticsCache()) return;
  const filters = normalizeGuildAnalyticsPreviewFilters(rawFilters);
  const entry = getAdminPreviewCacheEntry(adminGuildAnalyticsPreviewCacheState, previewCacheKey(filters), filters);
  void refreshAdminGuildAnalyticsPreviewCacheEntry(entry).catch(() => undefined);
}

export function warmAdminProviderMarketingPreviewCache(rawFilters: AdminProviderMarketingPreviewFilters = {}) {
  ensureAdminProviderMarketingPreviewBatchRefresh();
  if (!shouldPrewarmAdminAnalyticsCache()) return;
  const filters = normalizeProviderMarketingPreviewFilters(rawFilters);
  const entry = getAdminPreviewCacheEntry(adminProviderMarketingPreviewCacheState, previewCacheKey(filters), filters);
  void refreshAdminProviderMarketingPreviewCacheEntry(entry).catch(() => undefined);
}

export async function getAdminGuildAnalyticsPreview(
  rawFilters: AdminGuildAnalyticsPreviewFilters,
  options: { forceRefresh?: boolean } = {},
) {
  ensureAdminGuildAnalyticsPreviewBatchRefresh();
  const filters = normalizeGuildAnalyticsPreviewFilters(rawFilters);
  const entry = getAdminPreviewCacheEntry(adminGuildAnalyticsPreviewCacheState, previewCacheKey(filters), filters);
  if (options.forceRefresh || !entry.snapshot) {
    void refreshAdminGuildAnalyticsPreviewCacheEntry(entry).catch(() => undefined);
  }
  if (!entry.snapshot) {
    return withAdminPreviewCacheState(emptyGuildAnalyticsPreviewSnapshot(filters), entry);
  }
  return withAdminPreviewCacheState(entry.snapshot, entry);
}

export async function getAdminProviderMarketingPreview(
  rawFilters: AdminProviderMarketingPreviewFilters,
  options: { forceRefresh?: boolean } = {},
) {
  ensureAdminProviderMarketingPreviewBatchRefresh();
  const filters = normalizeProviderMarketingPreviewFilters(rawFilters);
  const entry = getAdminPreviewCacheEntry(adminProviderMarketingPreviewCacheState, previewCacheKey(filters), filters);
  if (options.forceRefresh || !entry.snapshot) {
    void refreshAdminProviderMarketingPreviewCacheEntry(entry).catch(() => undefined);
  }
  if (!entry.snapshot) {
    return withAdminPreviewCacheState(emptyProviderMarketingPreviewSnapshot(filters), entry);
  }
  return withAdminPreviewCacheState(entry.snapshot, entry);
}

async function getAdvancedAnalytics(now = Date.now()) {
  const dayStart = now - DAY_MS;
  const weekStart = now - 7 * DAY_MS;
  const monthStart = now - 30 * DAY_MS;
  const [
    metricTotals24h,
    metricTotals7d,
    providerReliability24h,
    providerReliability7d,
    hourlyTrend24h,
    topGuilds24h,
    topEndpoints24h,
    commandUsage24h,
    userUsage24h,
    providerAccountSummary7d,
    providerAccountHourly7d,
    providerGuildShare7d,
    providerContentHourly7d,
    providerContentGuildShare7d,
    providerContentFacets7d,
    providerContentUrls7d,
    urlAnalytics7d,
    mediaDelivery7d,
    audienceInterest7d,
    audit7d,
    errorBreakdown24h,
    analyticsQuality,
    derivedAggregates,
    aggregateOperationalTrend7d,
    funnelAnalytics,
    settingChangeImpact,
    settingAttributionSummary,
    weeklyCohorts,
    contentLifetime,
    urlReuse,
    providerAccountHealth,
    providerAnomalySignals,
    seasonality30d,
    eventDaySpikes30d,
    audienceCorrelation7d,
    settingAdoption,
    autoExtract,
    realtimeGuildIds,
  ] = await runLimited([
    () => optionalQuery([], () => getMetricTotals(dayStart)),
    () => optionalQuery([], () => getMetricTotals(weekStart)),
    () => optionalQuery([], () => getProviderAnalytics(dayStart)),
    () => optionalQuery([], () => getProviderAnalytics(weekStart)),
    () => optionalQuery([], () => getHourlyTrend(dayStart)),
    () => optionalQuery([], () => getTopGuildAnalytics(dayStart)),
    () => optionalQuery([], () => getEndpointAnalytics(dayStart)),
    () => optionalQuery([], () => getCommandUsageAnalytics(dayStart)),
    () => optionalQuery([], () => getUserUsageAnalytics(dayStart)),
    () => optionalQuery([], () => getProviderAccountSummary(weekStart)),
    () => optionalQuery([], () => getProviderAccountHourly(weekStart)),
    () => optionalQuery([], () => getProviderGuildShare(weekStart)),
    () => optionalQuery([], () => getProviderContentHourly(weekStart)),
    () => optionalQuery([], () => getProviderContentGuildShare(weekStart)),
    () => optionalQuery([], () => getProviderContentFacets(weekStart)),
    () => optionalQuery([], () => getProviderContentUrls(weekStart)),
    () => optionalQuery([], () => getUrlAnalytics(weekStart)),
    () => optionalQuery([], () => getMediaDeliveryAnalytics(weekStart)),
    () => optionalQuery([], () => getAudienceInterestAnalytics(weekStart)),
    () => optionalQuery({ actions: [], actors: [], guilds: [] }, () => getAuditAnalytics(weekStart)),
    () => optionalQuery({ commands: [], components: [], httpStatuses: [] }, () => getCommandAndComponentErrors(dayStart)),
    () => optionalQuery({ missingNativeAnalytics: [], enrichmentReliability: [], extractVsEnrichment: [], enrichmentSchemaVersions: [], enrichmentQueueOutcomes: [], providerRateLimits: [], providerDataErrors: [], metricNullRates: [], metricObservationQuality: [], requiredMetricCoverage: [], metricSchemaDrift: [], enrichmentSlo: [] }, () => getAnalyticsQualityDashboard(weekStart)),
    () => optionalQuery({ summary: { analytics_event_coverage_rate: 0, content_event_coverage_rate: 0, aggregate_lag_ms: null, aggregate_lag_hours: null, aggregate_stale: 0, data_source: "bot_provider_hourly_aggregates" }, providers: [], schemaVersions: [] }, () => getDerivedAggregateStatus(weekStart)),
    () => optionalQuery({ hourly: [], providerAccounts: [], contentTypes: [] }, () => getAggregateOperationalTrend(weekStart)),
    () => optionalQuery([], () => getFunnelAnalytics(weekStart)),
    () => optionalQuery([], () => getSettingChangeImpact(weekStart)),
    () => optionalQuery([], () => getSettingAttributionSummary(monthStart)),
    () => optionalQuery([], () => getWeeklyCohortAnalytics(weekStart)),
    () => optionalQuery([], () => getContentLifetimeAnalytics(monthStart)),
    () => optionalQuery([], () => getUrlReuseAnalytics(monthStart)),
    () => optionalQuery([], () => getProviderAccountHealth(weekStart)),
    () => optionalQuery([], () => getProviderAnomalySignals(now)),
    () => optionalQuery({ hours: [], weekdays: [], providerWeekdays: [] }, () => getAggregateSeasonalityAnalytics(monthStart)),
    () => optionalQuery({ days: [], providers: [] }, () => getAggregateEventDaySpikes(monthStart)),
    () => optionalQuery([], () => getAggregateAudienceCorrelation(weekStart)),
    () => optionalQuery([], () => getSettingAdoption()),
    () => optionalQuery({ summary: {}, topUsers: [], topAccounts: [] }, () => getAutoExtractAnalytics()),
    () => optionalQuery(null, () => fetchBotGuildIds()),
  ] as const);

  const [activeGuilds24h, activeProviders24h, activeGuilds7d, activeProviders7d, errors30d, analyticsEvents24h, analyticsUsers24h] = await runLimited([
    () => optionalQuery(0, () => scalarCount("SELECT COUNT(DISTINCT guild_id) AS count FROM bot_metric_buckets WHERE bucket_start_ms >= ? AND guild_id <> ''", dayStart)),
    () => optionalQuery(0, () => scalarCount("SELECT COUNT(DISTINCT provider_id) AS count FROM bot_metric_buckets WHERE bucket_start_ms >= ? AND provider_id <> ''", dayStart)),
    () => optionalQuery(0, () => scalarCount("SELECT COUNT(DISTINCT guild_id) AS count FROM bot_metric_buckets WHERE bucket_start_ms >= ? AND guild_id <> ''", weekStart)),
    () => optionalQuery(0, () => scalarCount("SELECT COUNT(DISTINCT provider_id) AS count FROM bot_metric_buckets WHERE bucket_start_ms >= ? AND provider_id <> ''", weekStart)),
    () => optionalQuery(0, () => scalarCount("SELECT COUNT(*) AS count FROM bot_error_events WHERE occurred_at_ms >= ?", monthStart)),
    () => optionalQuery(0, () => scalarCount("SELECT COUNT(*) AS count FROM bot_analytics_events WHERE occurred_at_ms >= ?", dayStart)),
    () => optionalQuery(0, () => scalarCount("SELECT COUNT(DISTINCT author_user_id) AS count FROM bot_analytics_events WHERE occurred_at_ms >= ? AND author_user_id IS NOT NULL", dayStart)),
  ] as const);

  const decisionInsights = buildDecisionInsights({
    analyticsQuality,
    providerAnomalySignals,
    providerAccountHealth,
    settingChangeImpact,
    settingAttributionSummary,
    funnelAnalytics,
    mediaDelivery7d,
    audienceCorrelation7d,
    seasonality30d,
    eventDaySpikes30d,
  });

  return clientSafe({
    windows: {
      generatedAt: new Date(now).toISOString(),
      dayStart: new Date(dayStart).toISOString(),
      weekStart: new Date(weekStart).toISOString(),
      monthStart: new Date(monthStart).toISOString(),
    },
    kpis: {
      activeGuilds24h,
      activeProviders24h,
      activeGuilds7d,
      activeProviders7d,
      errors30d,
      realtimeDiscordGuilds: realtimeGuildIds ? realtimeGuildIds.size : null,
      analyticsEvents24h,
      analyticsUsers24h,
    },
    metricTotals24h,
    metricTotals7d,
    providerReliability24h,
    providerReliability7d,
    hourlyTrend24h,
    topGuilds24h,
    topEndpoints24h,
    commandUsage24h,
    userUsage24h,
    providerAccountSummary7d,
    providerAccountHourly7d,
    providerGuildShare7d,
    providerContentHourly7d,
    providerContentGuildShare7d,
    providerContentFacets7d,
    providerContentUrls7d,
    urlAnalytics7d,
    mediaDelivery7d,
    audienceInterest7d,
    audit7d,
    errorBreakdown24h,
    analyticsQuality,
    derivedAggregates: {
      ...derivedAggregates,
      operationalTrend: aggregateOperationalTrend7d,
    },
    funnelAnalytics,
    settingChangeImpact,
    settingAttributionSummary,
    weeklyCohorts,
    contentLifetime,
    urlReuse,
    providerAccountHealth,
    providerAnomalySignals,
    seasonality30d,
    eventDaySpikes30d,
    audienceCorrelation7d,
    decisionInsights,
    settingAdoption,
    autoExtract,
  });
}

export function adminDatabaseTables() {
  return DATABASE_TABLES.map((table) => ({ ...table }));
}

type AdminOverviewSnapshot = Awaited<ReturnType<typeof buildAdminOverview>>;
type AdminAdvancedAnalyticsSnapshot = Awaited<ReturnType<typeof getAdvancedAnalytics>>;

type AdminOverviewCacheState = {
  snapshot: AdminOverviewSnapshot | null;
  updatedAtMs: number;
  lastAccessedAtMs: number;
  refreshPromise: Promise<AdminOverviewSnapshot> | null;
  timer: ReturnType<typeof setInterval> | null;
};

const adminOverviewCacheState = ((globalThis as typeof globalThis & {
  __cbteAdminOverviewCache?: AdminOverviewCacheState;
}).__cbteAdminOverviewCache ??= {
  snapshot: null,
  updatedAtMs: 0,
  lastAccessedAtMs: 0,
  refreshPromise: null,
  timer: null,
});

type AdminAdvancedAnalyticsCacheState = {
  snapshot: AdminAdvancedAnalyticsSnapshot | null;
  updatedAtMs: number;
  refreshPromise: Promise<AdminAdvancedAnalyticsSnapshot> | null;
};

const adminAdvancedAnalyticsCacheState = ((globalThis as typeof globalThis & {
  __cbteAdminAdvancedAnalyticsCache?: AdminAdvancedAnalyticsCacheState;
}).__cbteAdminAdvancedAnalyticsCache ??= {
  snapshot: null,
  updatedAtMs: 0,
  refreshPromise: null,
});

function emptyAdminOverviewSnapshot(): AdminOverviewSnapshot {
  return clientSafe({
    generatedAt: new Date().toISOString(),
    durationMs: 0,
    tables: DATABASE_TABLES.map((table) => ({
      table: table.name,
      label: table.label,
      available: false,
      count: 0,
      error: "analytics cache warming",
    })),
    totals: {
      users: 0,
      guilds: 0,
      providers: 0,
      settings: 0,
      autoExtractTargets: 0,
      auditLogs: 0,
      botErrorEvents: 0,
    },
    recent: {
      audit24h: 0,
      errors24h: 0,
      topErrorTypes: [],
      latestMetrics: [],
    },
    providerRows: [],
    analytics: null,
    health: {
      database: { ok: false, latencyMs: 0, serverTime: null },
      environment: {
        nodeEnv: process.env.NODE_ENV || "development",
        botTokenConfigured: false,
        clientIdConfigured: false,
        databaseUrlConfigured: false,
        status: "analytics_cache_warming",
      },
    },
  }) as AdminOverviewSnapshot;
}

function ensureAdminOverviewBatchRefresh() {
  if (adminOverviewCacheState.timer) return;
  const timer = setInterval(() => {
    if (!adminOverviewCacheState.lastAccessedAtMs || !isActiveAnalyticsCacheEntry(adminOverviewCacheState)) return;
    if (!shouldRefreshAnalyticsCacheEntry(adminOverviewCacheState)) return;
    void refreshAdminOverviewCache().catch(() => undefined);
  }, ADMIN_OVERVIEW_REFRESH_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  adminOverviewCacheState.timer = timer;
}

function withAdminOverviewCacheState(snapshot: AdminOverviewSnapshot) {
  const updatedAtMs = adminOverviewCacheState.updatedAtMs || 0;
  const analyticsUpdatedAtMs = adminAdvancedAnalyticsCacheState.updatedAtMs || 0;
  return clientSafe({
    ...snapshot,
    analytics: adminAdvancedAnalyticsCacheState.snapshot,
    cache: {
      updatedAt: updatedAtMs ? new Date(updatedAtMs).toISOString() : null,
      nextUpdateAt: updatedAtMs ? new Date(updatedAtMs + ADMIN_OVERVIEW_REFRESH_INTERVAL_MS).toISOString() : null,
      refreshIntervalMs: ADMIN_OVERVIEW_REFRESH_INTERVAL_MS,
      refreshing: Boolean(adminOverviewCacheState.refreshPromise || adminAdvancedAnalyticsCacheState.refreshPromise)
        || !adminOverviewCacheState.snapshot
        || !adminAdvancedAnalyticsCacheState.snapshot,
      ready: Boolean(adminOverviewCacheState.snapshot),
      analyticsUpdatedAt: analyticsUpdatedAtMs ? new Date(analyticsUpdatedAtMs).toISOString() : null,
    },
  });
}

function refreshAdminAdvancedAnalyticsCache() {
  if (!adminAdvancedAnalyticsCacheState.refreshPromise) {
    adminAdvancedAnalyticsCacheState.refreshPromise = enqueueAdminAnalyticsBuild(() => getAdvancedAnalytics())
      .then((snapshot) => {
        adminAdvancedAnalyticsCacheState.snapshot = snapshot;
        adminAdvancedAnalyticsCacheState.updatedAtMs = Date.now();
        return snapshot;
      })
      .finally(() => {
        adminAdvancedAnalyticsCacheState.refreshPromise = null;
      });
  }
  return adminAdvancedAnalyticsCacheState.refreshPromise;
}

function refreshAdminOverviewCache() {
  if (!adminOverviewCacheState.refreshPromise) {
    adminOverviewCacheState.refreshPromise = enqueueAdminAnalyticsBuild(() => buildAdminOverview())
      .then((snapshot) => {
        adminOverviewCacheState.snapshot = snapshot;
        adminOverviewCacheState.updatedAtMs = Date.now();
        return snapshot;
      })
      .finally(() => {
        adminOverviewCacheState.refreshPromise = null;
      });
  }
  return adminOverviewCacheState.refreshPromise;
}

export function warmAdminOverviewCache() {
  ensureAdminOverviewBatchRefresh();
  if (!shouldPrewarmAdminAnalyticsCache()) return;
  adminOverviewCacheState.lastAccessedAtMs = Date.now();
  if (!adminOverviewCacheState.snapshot && !adminOverviewCacheState.refreshPromise) {
    void refreshAdminOverviewCache().catch(() => undefined);
  }
}

export async function getAdminOverview(options: { forceRefresh?: boolean } = {}) {
  ensureAdminOverviewBatchRefresh();
  adminOverviewCacheState.lastAccessedAtMs = Date.now();
  if (options.forceRefresh || !adminOverviewCacheState.snapshot) {
    void refreshAdminOverviewCache().catch(() => undefined);
  }
  if (options.forceRefresh || !adminAdvancedAnalyticsCacheState.snapshot || shouldRefreshAnalyticsCacheEntry(adminAdvancedAnalyticsCacheState)) {
    void refreshAdminAdvancedAnalyticsCache().catch(() => undefined);
  }

  const snapshot = adminOverviewCacheState.snapshot;
  if (snapshot) {
    return withAdminOverviewCacheState(snapshot);
  }

  return withAdminOverviewCacheState(emptyAdminOverviewSnapshot());
}

async function buildAdminOverview() {
  await ensureAuditLogTable().catch(() => undefined);
  const startedAt = Date.now();
  const tableSummaries = await runLimited(DATABASE_TABLES.map((table) => () => tableCount(table.name)));
  const latencyStartedAt = Date.now();
  const dbPing = await optionalQuery<{ ok: boolean; latencyMs: number; serverTime: unknown }>(
    { ok: false, latencyMs: 0, serverTime: null },
    async () => {
      const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT NOW() AS now`;
      return { ok: true, latencyMs: Date.now() - latencyStartedAt, serverTime: serialize(rows[0]?.now || null) };
    },
  );
  const since24h = Date.now() - 24 * 60 * 60 * 1000;

  const [audit24h, errors24h, topErrorTypes, providerRows, latestMetrics] = await runLimited([
    () => optionalQuery(0, () => scalarCount("SELECT COUNT(*) AS count FROM dashboard_audit_logs WHERE created_at >= ?", new Date(since24h))),
    () => optionalQuery(0, () => scalarCount("SELECT COUNT(*) AS count FROM bot_error_events WHERE occurred_at_ms >= ?", since24h)),
    () => optionalQuery([], async () => {
      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT error_type, severity, provider_id, COUNT(*) AS count
         FROM bot_error_events
         WHERE occurred_at_ms >= ?
         GROUP BY error_type, severity, provider_id
         ORDER BY count DESC
         LIMIT 8`,
        since24h,
      );
      return rows.map(maskRow);
    }),
    () => optionalQuery([], async () => {
      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT provider_id, COUNT(*) AS configured_guilds, SUM(enabled = 1) AS enabled_guilds
         FROM guild_provider_settings
         GROUP BY provider_id
         ORDER BY configured_guilds DESC, provider_id ASC
         LIMIT 24`,
      );
      return rows.map(maskRow);
    }),
    () => optionalQuery([], async () => {
      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT metric_name, provider_id, guild_id, endpoint_key, count, bucket_start_ms
         FROM bot_metric_buckets
         ORDER BY bucket_start_ms DESC
         LIMIT 12`,
      );
      return rows.map(maskRow);
    }),
  ] as const);

  return clientSafe({
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    tables: tableSummaries,
    totals: {
      guilds: tableSummaries.find((item) => item.table === "guilds")?.count || 0,
      users: tableSummaries.find((item) => item.table === "users")?.count || 0,
      providers: tableSummaries.find((item) => item.table === "providers")?.count || 0,
      settings: tableSummaries.find((item) => item.table === "guild_provider_settings")?.count || 0,
      autoExtractTargets: tableSummaries.find((item) => item.table === "auto_extract_targets")?.count || 0,
      auditLogs: tableSummaries.find((item) => item.table === "dashboard_audit_logs")?.count || 0,
      botErrorEvents: tableSummaries.find((item) => item.table === "bot_error_events")?.count || 0,
    },
    recent: {
      audit24h,
      errors24h,
      topErrorTypes,
      latestMetrics,
    },
    providerRows,
    // Heavy aggregate reports are maintained independently so a slow report
    // cannot prevent the operational overview from becoming usable.
    analytics: null as AdminAdvancedAnalyticsSnapshot | null,
    health: {
      database: dbPing,
      environment: {
        nodeEnv: process.env.NODE_ENV || "development",
        botTokenConfigured: Boolean(getBotToken()),
        clientIdConfigured: Boolean(getClientId()),
        databaseUrlConfigured: Boolean(getDatabaseUrl()),
      },
    },
  });
}

export async function getAdminLogs(filters: {
  guildId?: string | null;
  providerId?: string | null;
  actorUserId?: string | null;
  action?: string | null;
  limit?: string | number | null;
}) {
  await ensureAuditLogTable().catch(() => undefined);
  const limit = limitValue(filters.limit, 100);
  const auditClauses: string[] = [];
  const auditParams: unknown[] = [];
  for (const [column, value] of [
    ["guild_id", filters.guildId],
    ["provider_id", filters.providerId],
    ["actor_user_id", filters.actorUserId],
    ["action", filters.action],
  ] as const) {
    if (!value) continue;
    auditClauses.push(`${column} = ?`);
    auditParams.push(value);
  }

  const errorClauses: string[] = [];
  const errorParams: unknown[] = [];
  for (const [column, value] of [
    ["guild_id", filters.guildId],
    ["provider_id", filters.providerId],
  ] as const) {
    if (!value) continue;
    errorClauses.push(`${column} = ?`);
    errorParams.push(value);
  }

  const [auditLogs, errorEvents] = await Promise.all([
    optionalQuery([], async () => {
      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT audit_log_id, guild_id, provider_id, setting_key, actor_user_id, actor_username_snapshot, action, before_json, after_json, request_id, created_at
         FROM dashboard_audit_logs
         ${auditClauses.length ? `WHERE ${auditClauses.join(" AND ")}` : ""}
         ORDER BY created_at DESC
         LIMIT ?`,
        ...auditParams,
        limit,
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
        createdAt: serialize(row.created_at),
      }));
    }),
    optionalQuery([], async () => {
      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT error_event_id, occurred_at_ms, error_type, severity, source, provider_id, endpoint_key, raw_url, normalized_url, guild_id, channel_id, message_id, command_name, component_id, discord_code, http_status, stack_hash, message_hash, details_json, created_at
         FROM bot_error_events
         ${errorClauses.length ? `WHERE ${errorClauses.join(" AND ")}` : ""}
         ORDER BY occurred_at_ms DESC
         LIMIT ?`,
        ...errorParams,
        limit,
      );
      return rows.map((row) => {
        const details = parseJson(row.details_json);
        const input = details && typeof details === "object" && !Array.isArray(details) ? (details as Row).input : null;
        return maskRow({
          error_event_id: row.error_event_id,
          occurred_at_ms: row.occurred_at_ms,
          error_type: row.error_type,
          severity: row.severity,
          source: row.source,
          provider_id: row.provider_id,
          endpoint_key: row.endpoint_key,
          raw_url: row.raw_url,
          input,
          normalized_url: row.normalized_url,
          guild_id: row.guild_id,
          channel_id: row.channel_id,
          message_id: row.message_id,
          command_name: row.command_name,
          component_id: row.component_id,
          discord_code: row.discord_code,
          http_status: row.http_status,
          stack_hash: row.stack_hash,
          message_hash: row.message_hash,
          details,
          created_at: row.created_at,
        });
      });
    }),
  ]);

  return clientSafe({ auditLogs, errorEvents, limit });
}

export async function getAdminDatabaseTable(tableName: string | null | undefined, rawLimit?: string | number | null) {
  const selected = tableName && tableMap.has(tableName) ? tableMap.get(tableName)! : DATABASE_TABLES[0];
  const limit = limitValue(rawLimit, 50);
  const table = quoteIdentifier(selected.name);
  const columns = await optionalQuery([], async () => {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SHOW COLUMNS FROM ${table}`);
    return rows.map(maskRow);
  });
  const hasOrderColumn = selected.orderBy && columns.some((column) => column.Field === selected.orderBy);
  const orderSql = hasOrderColumn ? `ORDER BY ${quoteIdentifier(selected.orderBy)} DESC` : "";
  const [summary, rows] = await Promise.all([
    tableCount(selected.name),
    optionalQuery([], async () => {
      const data = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT * FROM ${table} ${orderSql} LIMIT ?`, limit);
      return data.map(maskRow);
    }),
  ]);

  return clientSafe({
    selectedTable: selected.name,
    tables: adminDatabaseTables(),
    summary,
    columns,
    rows,
    limit,
  });
}

export async function getAdminProviderCatalog(locale: DashboardLocale = "ja") {
  const textLocale = locale === "ja" ? "ja" : "en";
  return clientSafe(getCatalog().map((provider) => ({
    providerId: provider.providerId,
    label: provider.label,
    enabledByDefault: provider.enabledByDefault,
    settings: provider.settings.map((setting) => ({
      key: setting.key,
      label: text(setting.label, textLocale),
      kind: setting.kind,
      dbColumn: setting.dbColumn,
      choices: setting.choices?.map((choice) => ({ value: choice.value, label: text(choice.label, textLocale) })),
    })),
  })));
}

export async function getAdminGuildSettings(guildId: string, providerId: string, locale: DashboardLocale = "ja") {
  if (!/^\d{5,32}$/.test(guildId)) throw new Error("Invalid guild id.");
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  const textLocale = locale === "ja" ? "ja" : "en";
  const [settings, recentLogs] = await Promise.all([
    getProviderSettingsState(providerId, guildId, locale),
    getAdminLogs({ guildId, providerId, limit: 20 }).then((logs) => logs.auditLogs),
  ]);
  return clientSafe({
    guildId,
    providerId,
    providerLabel: providerLabel(provider),
    settings,
    recentLogs,
    specs: getProviderSpecs(provider).map((setting) => ({
      key: setting.key,
      label: text(setting.label, textLocale),
      kind: setting.kind,
      dbColumn: setting.dbColumn,
      choices: setting.choices?.map((choice) => ({ value: choice.value, label: text(choice.label, textLocale) })),
    })),
  });
}

export async function saveAdminGuildSettings(
  input: {
    guildId?: unknown;
    providerId?: unknown;
    settingKey?: unknown;
    value?: unknown;
    changes?: unknown;
  },
  actor: AuditActor,
  meta: { requestId?: string | null; ip?: string | null; userAgent?: string | null },
  locale: DashboardLocale = "ja",
) {
  const guildId = String(input.guildId || "").trim();
  const providerId = String(input.providerId || "").trim();
  if (!/^\d{5,32}$/.test(guildId)) throw new Error("Invalid guild id.");
  if (!getProvider(providerId)) throw new Error(`Unknown provider: ${providerId}`);

  let changes: Record<string, SettingValue>;
  if (input.changes && typeof input.changes === "object" && !Array.isArray(input.changes)) {
    changes = input.changes as Record<string, SettingValue>;
  } else {
    const settingKey = String(input.settingKey || "").trim();
    if (!settingKey) throw new Error("settingKey is required.");
    changes = { [settingKey]: input.value as SettingValue };
  }

  const result = await saveProviderSettings(
    guildId,
    providerId,
    { changes },
    actor,
    meta,
    locale,
  );
  return clientSafe({
    guildId,
    providerId,
    changedKeys: Object.keys(changes),
    result,
  });
}
