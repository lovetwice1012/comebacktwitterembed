import { NextRequest } from "next/server";
import { errorResponse, json, requireGuildPermission } from "@/lib/api";
import { cleanupExpiredMedia, deleteMediaCacheItem, deleteProviderMediaCache, getMediaCacheStatus } from "@/lib/media-cache";

type Params = { params: Promise<{ guildId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { guildId } = await params;
    await requireGuildPermission(guildId, "manage");
    return json(await getMediaCacheStatus());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { guildId } = await params;
    await requireGuildPermission(guildId, "media");
    const body = await req.json().catch(() => ({}));
    if (body.action === "cleanupExpired") {
      return json({ cleanup: await cleanupExpiredMedia(), status: await getMediaCacheStatus() });
    }
    if (body.action === "deleteToken") {
      const deleted = await deleteMediaCacheItem(String(body.providerId || ""), String(body.token || ""));
      return json({ deleted, status: await getMediaCacheStatus() });
    }
    if (body.action === "deleteProvider") {
      const deleted = await deleteProviderMediaCache(String(body.providerId || ""));
      return json({ deleted, status: await getMediaCacheStatus() });
    }
    return json({ error: "Unsupported media action" }, 400);
  } catch (error) {
    return errorResponse(error);
  }
}
