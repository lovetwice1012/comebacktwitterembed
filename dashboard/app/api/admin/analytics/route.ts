import { NextRequest } from "next/server";
import { getIndependentAdminReport, independentReportsEnabled } from "@/lib/admin-report-client";
import { errorResponse, json, requireAdminSession } from "@/lib/api";
import { getAdminDetailedAnalytics } from "@/lib/admin-data";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";

export async function GET(req: NextRequest) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    const session = await requireAdminSession(locale);
    const search = req.nextUrl.searchParams;
    const filters = {
      providerId: search.get("provider_id"),
      accountKey: search.get("account_key"),
      guildId: search.get("guild_id"),
      authorUserId: search.get("author_user_id"),
      eventType: search.get("event_type"),
      commandName: search.get("command_name"),
      componentId: search.get("component_id"),
      contentType: search.get("content_type"),
      facetKey: search.get("facet_key"),
      dateFrom: search.get("date_from"),
      dateTo: search.get("date_to"),
      bucket: search.get("bucket"),
      limit: search.get("limit"),
    };
    const forceRefresh = search.get("refresh") === "1";
    if (independentReportsEnabled()) return json(await getIndependentAdminReport("analytics", filters, session.user.id, forceRefresh));
    return json(await getAdminDetailedAnalytics(filters, { forceRefresh }));
  } catch (error) {
    return errorResponse(error, locale);
  }
}
