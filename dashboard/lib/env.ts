import "server-only";

import fs from "node:fs";
import path from "node:path";

type RootConfig = {
  token?: string;
  clientId?: string;
  publicBaseUrl?: string;
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
  return process.env.DISCORD_CLIENT_ID || readRootConfig().clientId || "";
}

export function getDashboardBaseUrl() {
  return (process.env.NEXTAUTH_URL || process.env.DASHBOARD_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
}
