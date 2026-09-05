import { NextRequest } from "next/server";
import { getIndependentAdminReport, independentReportsEnabled } from "@/lib/admin-report-client";
import { errorResponse, json, requireAdminSession } from "@/lib/api";
import { getAdminProviderMarketingPreview } from "@/lib/admin-data";
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
      contentType: search.get("content_type"),
      facetKey: search.get("facet_key"),
      dateFrom: search.get("date_from"),
      dateTo: search.get("date_to"),
      bucket: search.get("bucket"),
      limit: search.get("limit"),
      urlVisibility: search.get("url_visibility"),
    };
    const forceRefresh = search.get("refresh") === "1";
    if (independentReportsEnabled()) return json(await getIndependentAdminReport("provider-preview", filters, session.user.id, forceRefresh));
    return json(await getAdminProviderMarketingPreview(filters, { forceRefresh }));
  } catch (error) {
    return errorResponse(error, locale);
  }
}
