import { NextRequest } from "next/server";
import { errorResponse, json, requireGuildPermission } from "@/lib/api";
import { createTranslator } from "@/lib/i18n";
import { cleanupExpiredMedia, deleteMediaCacheItem, deleteProviderMediaCache, getMediaDashboardStatus } from "@/lib/media-cache";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";

type Params = { params: Promise<{ guildId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    const { guildId } = await params;
    await requireGuildPermission(guildId, "manage", locale);
    return json(await getMediaDashboardStatus());
  } catch (error) {
    return errorResponse(error, locale);
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const locale = getDashboardLocaleFromRequest(req);
  const t = createTranslator(locale);
  try {
    const { guildId } = await params;
    await requireGuildPermission(guildId, "media", locale);
    const body = await req.json().catch(() => ({}));
    if (body.action === "cleanupExpired") {
      return json({ cleanup: await cleanupExpiredMedia(), status: await getMediaDashboardStatus() });
    }
    if (body.action === "deleteToken") {
      const deleted = await deleteMediaCacheItem(String(body.providerId || ""), String(body.token || ""));
      return json({ deleted, status: await getMediaDashboardStatus() });
    }
    if (body.action === "deleteProvider") {
      const deleted = await deleteProviderMediaCache(String(body.providerId || ""));
      return json({ deleted, status: await getMediaDashboardStatus() });
    }
    return json({ error: t("api.unsupportedMediaAction") }, 400);
  } catch (error) {
    return errorResponse(error, locale);
  }
}
