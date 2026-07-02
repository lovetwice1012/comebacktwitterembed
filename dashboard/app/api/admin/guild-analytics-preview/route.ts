import { NextRequest } from "next/server";
import { errorResponse, json, requireAdminSession } from "@/lib/api";
import { getAdminGuildAnalyticsPreview } from "@/lib/admin-data";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";

export async function GET(req: NextRequest) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    await requireAdminSession(locale);
    const search = req.nextUrl.searchParams;
    return json(await getAdminGuildAnalyticsPreview({
      guildId: search.get("guild_id"),
      providerId: search.get("provider_id"),
      accountKey: search.get("account_key"),
      contentType: search.get("content_type"),
      dateFrom: search.get("date_from"),
      dateTo: search.get("date_to"),
      bucket: search.get("bucket"),
      limit: search.get("limit"),
      urlVisibility: search.get("url_visibility"),
    }));
  } catch (error) {
    return errorResponse(error, locale);
  }
}
