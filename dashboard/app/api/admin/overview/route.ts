import { NextRequest } from "next/server";
import { getIndependentAdminReport, independentReportsEnabled } from "@/lib/admin-report-client";
import { errorResponse, json, requireAdminSession } from "@/lib/api";
import { getAdminOverview } from "@/lib/admin-data";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";

export async function GET(req: NextRequest) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    const session = await requireAdminSession(locale);
    const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";
    if (independentReportsEnabled()) return json(await getIndependentAdminReport("overview", {}, session.user.id, forceRefresh));
    return json(await getAdminOverview({ forceRefresh }));
  } catch (error) {
    return errorResponse(error, locale);
  }
}

export async function POST(req: NextRequest) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    const session = await requireAdminSession(locale);
    if (independentReportsEnabled()) return json(await getIndependentAdminReport("overview", {}, session.user.id, true));
    return json(await getAdminOverview({ forceRefresh: true }));
  } catch (error) {
    return errorResponse(error, locale);
  }
}
