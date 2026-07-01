import "server-only";

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { requireBotModule } from "@/lib/bot-require";

type CacheRecord = {
  token: string;
  filename: string;
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

function storeForProvider(providerId: string): StoreModule | null {
  if (providerId === "youtube") return requireBotModule<StoreModule>("src/youtubeDownloadStore.js");
  if (providerId === "niconico") return requireBotModule<StoreModule>("src/niconicoDownloadStore.js");
  return null;
}

function contentDisposition(filename: string) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function serveCachedMedia(providerId: string, token: string) {
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
    return new Response("Expired", { status: 410 });
  }

  const filesDir = store._internal.getFilesDir();
  const root = path.resolve(filesDir);
  const target = path.resolve(path.join(filesDir, record.token, record.filename));
  if (!target.startsWith(root + path.sep)) {
    return new Response("Not found", { status: 404 });
  }
  if (!fs.existsSync(target)) return new Response("Not found", { status: 404 });

  const stream = fs.createReadStream(target);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "Content-Type": store.contentTypeForFilename(record.filename),
      "Content-Disposition": contentDisposition(record.filename),
      "Cache-Control": "no-store",
    },
  });
}
