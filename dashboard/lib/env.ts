import "server-only";

import fs from "node:fs";
import path from "node:path";

type RootConfig = {
  token?: string;
  clientId?: string;
  clientSecret?: string;
  publicBaseUrl?: string;
  nextAuthSecret?: string;
  dashboard?: {
    enabled?: boolean;
    port?: number;
    publicBaseUrl?: string;
    baseUrl?: string;
    clientId?: string;
    clientSecret?: string;
    nextAuthSecret?: string;
    useBotGuildApi?: boolean;
    loadGuildProviderSummary?: boolean;
    discordApiTimeoutMs?: number;
    guildCacheTtlMs?: number;
    auditHashSecret?: string;
  };
  mediaDelivery?: {
    publicBaseUrl?: string;
    useLegacyRoutes?: boolean;
    serverMode?: string;
  };
  db?: {
    host?: string;
    user?: string;
    password?: string;
    database?: string;
    charset?: string;
  };
};

let cachedConfig: RootConfig | null = null;

export function repoRoot() {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "src", "providers"))) return cwd;
  if (fs.existsSync(path.join(cwd, "..", "src", "providers"))) return path.resolve(cwd, "..");
  return cwd;
}

export function readRootConfig(): RootConfig {
  if (cachedConfig) return cachedConfig;
  const configPath = path.join(repoRoot(), "config.json");
  try {
    cachedConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as RootConfig;
  } catch {
    cachedConfig = {};
  }
  return cachedConfig;
}

function encodePart(value: string) {
  return encodeURIComponent(value).replace(/%2F/g, "%252F");
}

export function getDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const cfg = readRootConfig().db || {};
  const host = process.env.DB_HOST || cfg.host || "localhost";
  const user = process.env.DB_USER || cfg.user || "comebacktwitterembed";
  const password = process.env.DB_PASSWORD || cfg.password || "bluebird";
  const database = process.env.DB_DATABASE || cfg.database || "ComebackTwitterEmbed";
  const charset = process.env.DB_CHARSET || cfg.charset || "utf8mb4";

  return `mysql://${encodePart(user)}:${encodePart(password)}@${host}:3306/${database}?charset=${charset}`;
}

export function getBotToken() {
  return process.env.DISCORD_BOT_TOKEN || process.env.BOT_TOKEN || readRootConfig().token || "";
}

export function getClientId() {
  const cfg = readRootConfig();
  return process.env.DISCORD_CLIENT_ID || cfg.dashboard?.clientId || cfg.clientId || "";
}

export function getClientSecret() {
  const cfg = readRootConfig();
  return process.env.DISCORD_CLIENT_SECRET || cfg.dashboard?.clientSecret || cfg.clientSecret || "";
}

export function getNextAuthSecret() {
  const cfg = readRootConfig();
  return process.env.NEXTAUTH_SECRET || cfg.dashboard?.nextAuthSecret || cfg.nextAuthSecret || "";
}

export function getDashboardBaseUrl() {
  const cfg = readRootConfig();
  const port = Number(process.env.DASHBOARD_PORT || cfg.dashboard?.port || 30987);
  return (
    process.env.NEXTAUTH_URL
    || process.env.DASHBOARD_BASE_URL
    || cfg.dashboard?.publicBaseUrl
    || cfg.dashboard?.baseUrl
    || cfg.mediaDelivery?.publicBaseUrl
    || cfg.publicBaseUrl
    || `http://localhost:${port}`
  ).replace(/\/+$/, "");
}

export function getDashboardFlag(key: "useBotGuildApi" | "loadGuildProviderSummary", envName: string) {
  const envValue = process.env[envName];
  if (envValue !== undefined && envValue !== "") return /^(1|true|yes|on)$/i.test(envValue);
  return readRootConfig().dashboard?.[key] === true;
}

export function getDashboardNumber(key: "discordApiTimeoutMs" | "guildCacheTtlMs", envName: string, fallback: number) {
  const envValue = Number(process.env[envName]);
  if (Number.isFinite(envValue) && envValue > 0) return envValue;
  const configValue = Number(readRootConfig().dashboard?.[key]);
  return Number.isFinite(configValue) && configValue > 0 ? configValue : fallback;
}

export function getAuditHashSecret() {
  const cfg = readRootConfig();
  return process.env.DASHBOARD_AUDIT_HASH_SECRET || cfg.dashboard?.auditHashSecret || getNextAuthSecret() || "dashboard-audit";
}
