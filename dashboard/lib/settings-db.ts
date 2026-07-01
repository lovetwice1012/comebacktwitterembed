import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  editableSpecs,
  getBotProviders,
  getProvider,
  getProviderDefaults,
  getProviderSettingColumns,
  getProviderSpecs,
  providerDomain,
  providerLabel,
} from "@/lib/settings-catalog";
import { deepEqual } from "@/lib/settings-diff";
import { settingWarnings, validateProviderChanges } from "@/lib/settings-validation";
import { recordAuditLog } from "@/lib/audit-log";
import { createTranslator, type DashboardLocale } from "@/lib/i18n";
import type {
  AuditActor,
  ButtonVisibility,
  ProviderCatalogItem,
  ProviderSummary,
  SettingSpec,
  SettingState,
  SettingValue,
  TargetSetting,
} from "@/lib/types";

type Tx = Prisma.TransactionClient | PrismaClient;

const SPECIAL_TARGET_TABLES: Record<string, string> = {
  disable: "guild_provider_disable_targets",
  button_disabled: "guild_provider_button_disabled_targets",
};

const buttonKeys = ["showMediaAsAttachments", "showAttachmentsAsEmbedsImage", "translate", "delete", "all"] as const;

function normalizeHiddenOutputItems(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    if (text.startsWith("[")) {
      try {
        return normalizeHiddenOutputItems(JSON.parse(text));
      } catch {
        return [];
      }
    }
    return normalizeHiddenOutputItems(text.split(","));
  }
  return [];
}

function normalizeTargetSetting(raw: Partial<TargetSetting> | null | undefined): TargetSetting {
  return {
    user: [...new Set(raw?.user || [])],
    channel: [...new Set(raw?.channel || [])],
    role: [...new Set(raw?.role || [])],
  };
}

function buttonDefaults(providerId: string): ButtonVisibility {
  const defaults: ButtonVisibility = Object.fromEntries(buttonKeys.map((key) => [key, false]));
  if (providerId === "twitter") defaults.savetweet = false;
  return defaults;
}

function normalizeButtonVisibility(providerId: string, raw: ButtonVisibility | null | undefined): ButtonVisibility {
  const value = { ...buttonDefaults(providerId), ...(raw || {}) };
  if (providerId !== "twitter") delete value.savetweet;
  return value;
}

function providerSettingDefault(provider: { id: string; enabledByDefault?: boolean }, key: string): SettingValue | undefined {
  if (key === "enabled") return provider.enabledByDefault === true;
  if (key === "youtube_description_max_length") return provider.id === "youtube" ? 1400 : undefined;
  if (key === "pixiv_caption_max_length") return provider.id === "pixiv" ? 350 : undefined;
  if (key === "instagram_caption_max_length") return provider.id === "instagram" ? 3000 : undefined;
  if (key === "instagram_media_limit") return provider.id === "instagram" ? 10 : undefined;
  if (key === "tiktok_description_max_length") return provider.id === "tiktok" ? 900 : undefined;
  if (key === "tiktok_video_fallback_mode") return provider.id === "tiktok" ? "video_url" : undefined;
  if (key === "niconico_description_max_length") return provider.id === "niconico" ? 1400 : undefined;
  if (key === "spotify_description_max_length") return provider.id === "spotify" ? 350 : undefined;
  if (key === "twitch_description_max_length") return provider.id === "twitch" ? 1500 : undefined;
  if (key === "steam_description_max_length") return provider.id === "steam" ? 900 : undefined;
  if (key === "steam_image_source") return provider.id === "steam" ? "header" : undefined;
  if (key === "amazon_description_max_length") return provider.id === "amazon" ? 700 : undefined;
  if (key === "booth_description_max_length") return provider.id === "booth" ? 350 : undefined;
  if (key === "booth_adult_display_mode") return provider.id === "booth" ? "normal" : undefined;
  const base = getProviderDefaults()[key];
  if (Array.isArray(base)) return [...base] as string[];
  if (base === undefined) return undefined;
  return base as SettingValue;
}

function convertDatabaseValue(raw: unknown, spec: { type: string }): SettingValue | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (spec.type === "bool") return raw === true || raw === 1 || raw === BigInt(1);
  if (spec.type === "int") return Number(raw);
  if (spec.type === "jsonArray") return normalizeHiddenOutputItems(raw);
  return String(raw);
}

function toDatabaseValue(value: SettingValue | undefined, spec: { type: string }) {
  if (value === null || value === undefined) return null;
  if (spec.type === "bool") return value === true ? 1 : 0;
  if (spec.type === "int") return Number(value);
  if (spec.type === "jsonArray") return JSON.stringify(normalizeHiddenOutputItems(value));
  return String(value);
}

async function ensureProviderAndGuild(db: Tx, providerId: string, guildId: string) {
  await db.$executeRaw`INSERT INTO providers (provider_id) VALUES (${providerId}) ON DUPLICATE KEY UPDATE provider_id = provider_id`;
  await db.$executeRaw`INSERT INTO guilds (guild_id) VALUES (${guildId}) ON DUPLICATE KEY UPDATE guild_id = guild_id`;
}

async function readScalarRow(providerId: string, guildId: string): Promise<Record<string, unknown> | null> {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "SELECT * FROM guild_provider_settings WHERE provider_id = ? AND guild_id = ? LIMIT 1",
    providerId,
    guildId,
  );
  return rows[0] || null;
}

async function setScalar(db: Tx, providerId: string, guildId: string, key: string, value: SettingValue | undefined) {
  const columnSpec = getProviderSettingColumns()[key];
  if (!columnSpec) return;
  await ensureProviderAndGuild(db, providerId, guildId);
  await db.$executeRawUnsafe(
    `INSERT INTO guild_provider_settings (provider_id, guild_id, ${columnSpec.column})
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE ${columnSpec.column} = VALUES(${columnSpec.column})`,
    providerId,
    guildId,
    toDatabaseValue(value, columnSpec),
  );
}

async function readTargetRows(table: string, providerId: string, guildId: string): Promise<TargetSetting> {
  const rows = await prisma.$queryRawUnsafe<Array<{ target_type: "user" | "channel" | "role"; target_id: string }>>(
    `SELECT target_type, target_id FROM ${table} WHERE provider_id = ? AND guild_id = ?`,
    providerId,
    guildId,
  );
  const out: TargetSetting = { user: [], channel: [], role: [] };
  for (const row of rows) out[row.target_type]?.push(row.target_id);
  return normalizeTargetSetting(out);
}

async function replaceTargetRows(db: Tx, table: string, providerId: string, guildId: string, value: SettingValue) {
  const setting = normalizeTargetSetting(value as TargetSetting);
  await ensureProviderAndGuild(db, providerId, guildId);
  await db.$executeRawUnsafe(`DELETE FROM ${table} WHERE provider_id = ? AND guild_id = ?`, providerId, guildId);
  for (const targetType of ["user", "channel", "role"] as const) {
    for (const targetId of setting[targetType]) {
      await db.$executeRawUnsafe(
        `INSERT INTO ${table} (provider_id, guild_id, target_type, target_id) VALUES (?, ?, ?, ?)`,
        providerId,
        guildId,
        targetType,
        targetId,
      );
    }
  }
}

async function readBannedWords(providerId: string, guildId: string) {
  const rows = await prisma.$queryRaw<Array<{ word: string }>>`
    SELECT word FROM guild_provider_banned_words
    WHERE provider_id = ${providerId} AND guild_id = ${guildId}
    ORDER BY word
  `;
  return rows.map((row) => row.word);
}

async function replaceBannedWords(db: Tx, providerId: string, guildId: string, value: SettingValue) {
  const words = Array.isArray(value) ? value.map((word) => String(word || "").normalize("NFC").trim()).filter(Boolean) : [];
  await ensureProviderAndGuild(db, providerId, guildId);
  await db.$executeRaw`DELETE FROM guild_provider_banned_words WHERE provider_id = ${providerId} AND guild_id = ${guildId}`;
  for (const word of [...new Set(words)]) {
    await db.$executeRaw`INSERT INTO guild_provider_banned_words (provider_id, guild_id, word) VALUES (${providerId}, ${guildId}, ${word})`;
  }
}

async function readButtonVisibility(providerId: string, guildId: string) {
  const rows = await prisma.$queryRaw<Array<{ button_key: string; hidden: boolean | number }>>`
    SELECT button_key, hidden FROM guild_provider_button_visibility
    WHERE provider_id = ${providerId} AND guild_id = ${guildId}
  `;
  const raw: ButtonVisibility = {};
  for (const row of rows) raw[row.button_key] = row.hidden === true || row.hidden === 1;
  return normalizeButtonVisibility(providerId, raw);
}

async function replaceButtonVisibility(db: Tx, providerId: string, guildId: string, value: SettingValue) {
  const visibility = normalizeButtonVisibility(providerId, value as ButtonVisibility);
  await ensureProviderAndGuild(db, providerId, guildId);
  await db.$executeRaw`DELETE FROM guild_provider_button_visibility WHERE provider_id = ${providerId} AND guild_id = ${guildId}`;
  for (const [buttonKey, hidden] of Object.entries(visibility)) {
    await db.$executeRaw`
      INSERT INTO guild_provider_button_visibility (provider_id, guild_id, button_key, hidden)
      VALUES (${providerId}, ${guildId}, ${buttonKey}, ${hidden ? 1 : 0})
    `;
  }
}

async function readRawValues(providerId: string, guildId: string, specs: SettingSpec[]) {
  const columns = getProviderSettingColumns();
  const needsScalarRow = specs.some((spec) => spec.kind !== "targets" && spec.kind !== "bannedWords" && spec.kind !== "buttonVisibility" && columns[spec.key]);
  const targetSpecs = specs.filter((spec) => spec.kind === "targets" && SPECIAL_TARGET_TABLES[spec.key]);
  const needsBannedWords = specs.some((spec) => spec.kind === "bannedWords");
  const needsButtonVisibility = specs.some((spec) => spec.kind === "buttonVisibility");

  const [scalarRow, targetValues, bannedWords, buttonVisibility] = await Promise.all([
    needsScalarRow ? readScalarRow(providerId, guildId) : Promise.resolve(null),
    Promise.all(targetSpecs.map(async (spec) => [spec.key, await readTargetRows(SPECIAL_TARGET_TABLES[spec.key], providerId, guildId)] as const)),
    needsBannedWords ? readBannedWords(providerId, guildId) : Promise.resolve(undefined),
    needsButtonVisibility ? readButtonVisibility(providerId, guildId) : Promise.resolve(undefined),
  ]);

  const values = new Map<string, SettingValue | undefined>();
  for (const spec of specs) {
    if (spec.kind === "targets") {
      const target = targetValues.find(([key]) => key === spec.key);
      values.set(spec.key, target?.[1]);
      continue;
    }
    if (spec.kind === "bannedWords") {
      values.set(spec.key, bannedWords);
      continue;
    }
    if (spec.kind === "buttonVisibility") {
      values.set(spec.key, buttonVisibility);
      continue;
    }

    const columnSpec = columns[spec.key];
    values.set(spec.key, columnSpec ? convertDatabaseValue(scalarRow?.[columnSpec.column], columnSpec) : undefined);
  }
  return values;
}

async function writeValue(db: Tx, providerId: string, guildId: string, spec: SettingSpec, value: SettingValue | undefined) {
  if (spec.kind === "targets") return replaceTargetRows(db, SPECIAL_TARGET_TABLES[spec.key], providerId, guildId, value || { user: [], channel: [], role: [] });
  if (spec.kind === "bannedWords") return replaceBannedWords(db, providerId, guildId, value || []);
  if (spec.kind === "buttonVisibility") return replaceButtonVisibility(db, providerId, guildId, value || {});
  return setScalar(db, providerId, guildId, spec.key, value);
}

function defaultForSpec(provider: { id: string; enabledByDefault?: boolean }, spec: SettingSpec): SettingValue | undefined {
  if (spec.kind === "targets") return { user: [], channel: [], role: [] };
  if (spec.kind === "bannedWords" || spec.kind === "outputVisibility") return [];
  if (spec.kind === "buttonVisibility") return buttonDefaults(provider.id);
  return providerSettingDefault(provider, spec.key);
}

export async function getProviderSettingsState(providerId: string, guildId: string, locale: DashboardLocale = "ja"): Promise<SettingState[]> {
  const t = createTranslator(locale);
  const provider = getProvider(providerId);
  if (!provider) throw new Error(t("validation.unknownProvider", { providerId }));
  const specs = editableSpecs(providerId);
  const rawValues = await readRawValues(providerId, guildId, specs);
  const rawStates = specs.map((spec) => {
    const rawValue = rawValues.get(spec.key);
    const defaultValue = defaultForSpec(provider, spec);
    const value = rawValue === undefined ? defaultValue : rawValue;
    return {
      key: spec.key,
      kind: spec.kind,
      spec,
      value: (value === undefined ? null : value) as SettingValue,
      rawValue,
      defaultValue,
      customized: rawValue !== undefined && !deepEqual(rawValue, defaultValue),
      changedFromDefault: !deepEqual(value, defaultValue),
      warnings: [],
      dependencies: spec.dependencies,
      conflicts: spec.conflicts,
    } satisfies SettingState;
  });

  const values = Object.fromEntries(rawStates.map((state) => [state.key, state.value]));
  return rawStates.map((state) => ({
    ...state,
    warnings: settingWarnings(state.key, state.value, values, locale),
  }));
}

export async function getProvidersOverview(guildId: string, locale: DashboardLocale = "ja") {
  const providers = getBotProviders();
  return Promise.all(
    providers.map(async (provider) => {
      const states = await getProviderSettingsState(provider.id, guildId, locale);
      const enabled = states.find((state) => state.key === "enabled")?.value === true;
      const customizedSettingCount = states.filter((state) => state.changedFromDefault).length;
      const warnings = states.flatMap((state) => state.warnings);
      return {
        providerId: provider.id,
        label: providerLabel(provider),
        domain: providerDomain(provider.id),
        enabled,
        enabledByDefault: provider.enabledByDefault === true,
        changedFromDefault: customizedSettingCount > 0,
        settingCount: states.length,
        customizedSettingCount,
        displayDensity: states.find((state) => state.key === "display_density")?.value,
        mediaDisplayMode: states.find((state) => state.key === "media_display_mode")?.value,
        failureDisplayPolicy: states.find((state) => state.key === "failure_display_policy")?.value,
        warnings,
      };
    }),
  );
}

export async function getProviderSummary(guildId: string): Promise<ProviderSummary> {
  const overview = await getProvidersOverview(guildId);
  const enabled = overview.filter((provider) => provider.enabled).length;
  return {
    enabled,
    disabled: overview.length - enabled,
    total: overview.length,
  };
}

export function catalogForGuild(): ProviderCatalogItem[] {
  return getBotProviders().map((provider) => ({
    providerId: provider.id,
    label: providerLabel(provider),
    enabledByDefault: provider.enabledByDefault === true,
    settings: getProviderSpecs(provider),
  }));
}

export async function saveProviderSettings(
  guildId: string,
  providerId: string,
  body: unknown,
  actor: AuditActor,
  meta: { requestId?: string | null; ip?: string | null; userAgent?: string | null } = {},
  locale: DashboardLocale = "ja",
) {
  const t = createTranslator(locale);
  const provider = getProvider(providerId);
  if (!provider) throw new Error(t("validation.unknownProvider", { providerId }));
  const validated = validateProviderChanges(providerId, body, locale);
  const specs = new Map(editableSpecs(providerId).map((spec) => [spec.key, spec]));
  const before = await getProviderSettingsState(providerId, guildId, locale);
  const beforeByKey = new Map(before.map((state) => [state.key, state]));

  await prisma.$transaction(async (tx) => {
    for (const [key, value] of Object.entries(validated.changes)) {
      const spec = specs.get(key);
      if (!spec) continue;
      const beforeValue = beforeByKey.get(key)?.value;
      await writeValue(tx, providerId, guildId, spec, value === null ? undefined : value);
      await recordAuditLog(tx, {
        guildId,
        providerId,
        settingKey: key,
        actor,
        action: "setting.update",
        before: beforeValue,
        after: value,
        ...meta,
      });
    }
  });

  return {
    providerId,
    warnings: validated.warnings,
    settings: await getProviderSettingsState(providerId, guildId, locale),
  };
}

export async function resetProviderSettings(
  guildId: string,
  providerId: string,
  actor: AuditActor,
  meta: { requestId?: string | null; ip?: string | null; userAgent?: string | null } = {},
  locale: DashboardLocale = "ja",
) {
  const t = createTranslator(locale);
  const provider = getProvider(providerId);
  if (!provider) throw new Error(t("validation.unknownProvider", { providerId }));
  const before = await getProviderSettingsState(providerId, guildId, locale);
  const specs = editableSpecs(providerId);

  await prisma.$transaction(async (tx) => {
    await ensureProviderAndGuild(tx, providerId, guildId);
    const scalarColumns = specs
      .map((spec) => getProviderSettingColumns()[spec.key]?.column)
      .filter(Boolean);
    if (scalarColumns.length > 0) {
      await tx.$executeRawUnsafe(
        `UPDATE guild_provider_settings SET ${scalarColumns.map((column) => `${column} = NULL`).join(", ")} WHERE provider_id = ? AND guild_id = ?`,
        providerId,
        guildId,
      );
    }
    await tx.$executeRaw`DELETE FROM guild_provider_disable_targets WHERE provider_id = ${providerId} AND guild_id = ${guildId}`;
    await tx.$executeRaw`DELETE FROM guild_provider_button_disabled_targets WHERE provider_id = ${providerId} AND guild_id = ${guildId}`;
    await tx.$executeRaw`DELETE FROM guild_provider_banned_words WHERE provider_id = ${providerId} AND guild_id = ${guildId}`;
    await tx.$executeRaw`DELETE FROM guild_provider_button_visibility WHERE provider_id = ${providerId} AND guild_id = ${guildId}`;
    await recordAuditLog(tx, {
      guildId,
      providerId,
      actor,
      action: "provider.reset",
      before,
      after: null,
      ...meta,
    });
  });

  return {
    providerId,
    settings: await getProviderSettingsState(providerId, guildId, locale),
  };
}

export async function saveBulkProviderSettings(
  guildId: string,
  body: unknown,
  actor: AuditActor,
  meta: { requestId?: string | null; ip?: string | null; userAgent?: string | null } = {},
  locale: DashboardLocale = "ja",
) {
  const input = body as {
    providerIds?: string[];
    changes?: Record<string, unknown>;
  };
  const providerIds = input.providerIds?.length ? input.providerIds : getBotProviders().map((provider) => provider.id);
  const results = [];
  for (const providerId of providerIds) {
    const result = await saveProviderSettings(guildId, providerId, { changes: input.changes || {} }, actor, meta, locale);
    results.push({ providerId, warnings: result.warnings });
  }
  return { updatedProviders: results };
}
