import "server-only";

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { requireBotModule } from "@/lib/bot-require";

type CacheRecord = {
  token: string;
  filename: string;
  sizeBytes?: number;
  url?: string;
  expiresAtMs?: number;
};

type StoreModule = {
  cleanupExpiredDownloads: () => Promise<number>;
  contentTypeForFilename: (filename: string) => string;
  _internal: {
    getFilesDir: () => string;
    readIndex: () => Promise<Record<string, CacheRecord>>;
  };
};

type ErrorTrackingModule = {
  recordAnalyticsEvent?: (eventType: string, context?: Record<string, unknown>) => void;
};

function storeForProvider(providerId: string): StoreModule | null {
  if (providerId === "youtube") return requireBotModule<StoreModule>("src/youtubeDownloadStore.js");
  if (providerId === "niconico") return requireBotModule<StoreModule>("src/niconicoDownloadStore.js");
  return null;
}

function contentDisposition(filename: string) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function recordMediaDeliveryEvent(
  providerId: string,
  record: CacheRecord | null,
  success: boolean,
  status: number,
  startedAt: number,
  details: Record<string, unknown> = {},
) {
  if (!record) return;
  try {
    const { recordAnalyticsEvent } = requireBotModule<ErrorTrackingModule>("src/errorTracking.js");
    recordAnalyticsEvent?.("media_delivery", {
      source: "dashboard.media_delivery",
      providerId,
      url: record.url,
      success,
      durationMs: Date.now() - startedAt,
      details: {
        status,
        size_bytes: record.sizeBytes || null,
        expires_at_ms: record.expiresAtMs || null,
        ...details,
      },
    });
  } catch {
    // Analytics recording must never affect media delivery.
  }
}

export async function serveCachedMedia(providerId: string, token: string) {
  const startedAt = Date.now();
  const store = storeForProvider(providerId);
  if (!store) return new Response("Not found", { status: 404 });
  if (!/^[A-Za-z0-9_-]{16,}$/.test(String(token || ""))) {
    return new Response("Not found", { status: 404 });
  }

  await store.cleanupExpiredDownloads();
  const index = await store._internal.readIndex();
  const record = index[token];
  if (!record) return new Response("Not found", { status: 404 });
  if (Number(record.expiresAtMs || 0) <= Date.now()) {
    await store.cleanupExpiredDownloads();
    recordMediaDeliveryEvent(providerId, record, false, 410, startedAt, { outcome: "expired" });
    return new Response("Expired", { status: 410 });
  }

  const filesDir = store._internal.getFilesDir();
  const root = path.resolve(filesDir);
  const target = path.resolve(path.join(filesDir, record.token, record.filename));
  if (!target.startsWith(root + path.sep)) {
    recordMediaDeliveryEvent(providerId, record, false, 404, startedAt, { outcome: "path_rejected" });
    return new Response("Not found", { status: 404 });
  }
  if (!fs.existsSync(target)) {
    recordMediaDeliveryEvent(providerId, record, false, 404, startedAt, { outcome: "missing_file" });
    return new Response("Not found", { status: 404 });
  }

  const stream = fs.createReadStream(target);
  recordMediaDeliveryEvent(providerId, record, true, 200, startedAt, { outcome: "served" });
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "Content-Type": store.contentTypeForFilename(record.filename),
      "Content-Disposition": contentDisposition(record.filename),
      "Cache-Control": "no-store",
    },
  });
}
