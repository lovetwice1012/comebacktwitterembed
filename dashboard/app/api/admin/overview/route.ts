import { NextRequest } from "next/server";
import { errorResponse, json, requireAdminSession } from "@/lib/api";
import { getAdminOverview } from "@/lib/admin-data";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";

export async function GET(req: NextRequest) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    await requireAdminSession(locale);
    return json(await getAdminOverview({ forceRefresh: req.nextUrl.searchParams.get("refresh") === "1" }));
  } catch (error) {
    return errorResponse(error, locale);
  }
}

export async function POST(req: NextRequest) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    await requireAdminSession(locale);
    return json(await getAdminOverview({ forceRefresh: true }));
  } catch (error) {
    return errorResponse(error, locale);
  }
}
