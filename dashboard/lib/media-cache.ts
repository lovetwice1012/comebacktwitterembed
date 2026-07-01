import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { requireBotModule } from "@/lib/bot-require";
import { getProvider, providerDomain, providerLabel } from "@/lib/settings-catalog";

type StoreModule = {
  ROUTE_PREFIX: string;
  getPublicBaseUrl: () => string;
  isDownloadButtonEnabled: () => boolean;
  cleanupExpiredDownloads: () => Promise<number>;
  deleteCachedDownload?: (token: string) => Promise<boolean>;
  listCachedDownloads?: () => Promise<CacheRecord[]>;
  _internal: {
    getRootDir: () => string;
    getFilesDir: () => string;
    getIndexPath: () => string;
    ttlMs: () => number;
    readIndex: () => Promise<Record<string, CacheRecord>>;
  };
};

type CacheRecord = {
  token: string;
  filename: string;
  sizeBytes?: number;
  createdAtMs?: number;
  expiresAtMs?: number;
  url?: string;
};

function stores(): Record<string, StoreModule> {
  return {
    youtube: requireBotModule<StoreModule>("src/youtubeDownloadStore.js"),
    niconico: requireBotModule<StoreModule>("src/niconicoDownloadStore.js"),
  };
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += (await fs.stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

export async function getMediaCacheStatus() {
  const now = Date.now();
  const providers = await Promise.all(
    Object.entries(stores()).map(async ([providerId, store]) => {
      const records = store.listCachedDownloads
        ? await store.listCachedDownloads().catch(() => [])
        : Object.values(await store._internal.readIndex().catch(() => ({})));
      const expired = records.filter((record) => Number(record.expiresAtMs || 0) <= now).length;
      const filesDir = store._internal.getFilesDir();
      return {
        providerId,
        routePrefix: store.ROUTE_PREFIX,
        unifiedRoutePrefix: `/media/${providerId}`,
        publicBaseUrl: store.getPublicBaseUrl(),
        rootDir: store._internal.getRootDir(),
        filesDir,
        indexPath: store._internal.getIndexPath(),
        ttlMs: store._internal.ttlMs(),
        downloadButtonEnabled: store.isDownloadButtonEnabled(),
        cacheCount: records.length,
        expiredCount: expired,
        totalSizeBytes: await dirSize(filesDir),
        items: records
          .sort((a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0))
          .slice(0, 100)
          .map((record) => ({
            token: record.token,
            filename: record.filename,
            sizeBytes: record.sizeBytes || 0,
            createdAtMs: record.createdAtMs || null,
            expiresAtMs: record.expiresAtMs || null,
            publicUrl: `${store.getPublicBaseUrl()}${store.ROUTE_PREFIX}/${encodeURIComponent(record.token)}/${encodeURIComponent(record.filename)}`,
            unifiedUrl: `${store.getPublicBaseUrl()}/media/${providerId}/${encodeURIComponent(record.token)}/${encodeURIComponent(record.filename)}`,
          })),
      };
    }),
  );

  return {
    running: true,
    cleanupIntervalMs: 60_000,
    providers,
    totalCacheCount: providers.reduce((sum, provider) => sum + provider.cacheCount, 0),
    totalSizeBytes: providers.reduce((sum, provider) => sum + provider.totalSizeBytes, 0),
    expiredCount: providers.reduce((sum, provider) => sum + provider.expiredCount, 0),
  };
}

export async function getMediaDashboardStatus() {
  const status = await getMediaCacheStatus();
  return {
    running: status.running,
    providers: status.providers.map((provider) => {
      const providerDef = getProvider(provider.providerId);
      return {
        providerId: provider.providerId,
        label: providerDef ? providerLabel(providerDef) : provider.providerId,
        domain: providerDomain(provider.providerId),
        cacheCount: provider.cacheCount,
        expiredCount: provider.expiredCount,
        totalSizeBytes: provider.totalSizeBytes,
      };
    }),
    totalCacheCount: status.totalCacheCount,
    totalSizeBytes: status.totalSizeBytes,
    expiredCount: status.expiredCount,
  };
}

export async function cleanupExpiredMedia() {
  const result: Record<string, number> = {};
  for (const [providerId, store] of Object.entries(stores())) {
    result[providerId] = await store.cleanupExpiredDownloads();
  }
  return result;
}

export async function deleteMediaCacheItem(providerId: string, token: string) {
  const store = stores()[providerId];
  if (!store || !store.deleteCachedDownload) return false;
  return store.deleteCachedDownload(token);
}

export async function deleteProviderMediaCache(providerId: string) {
  const store = stores()[providerId];
  if (!store || !store.deleteCachedDownload) return 0;
  const records = store.listCachedDownloads
    ? await store.listCachedDownloads().catch(() => [])
    : Object.values(await store._internal.readIndex().catch(() => ({})));
  let deleted = 0;
  for (const record of records) {
    if (await store.deleteCachedDownload(record.token)) deleted += 1;
  }
  return deleted;
}
