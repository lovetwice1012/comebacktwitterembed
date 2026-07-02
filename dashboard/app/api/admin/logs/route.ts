import { NextRequest } from "next/server";
import { errorResponse, json, requireAdminSession } from "@/lib/api";
import { getAdminLogs } from "@/lib/admin-data";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";

export async function GET(req: NextRequest) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    await requireAdminSession(locale);
    const search = req.nextUrl.searchParams;
    return json(await getAdminLogs({
      guildId: search.get("guild_id"),
      providerId: search.get("provider_id"),
      actorUserId: search.get("actor_user_id"),
      action: search.get("action"),
      limit: search.get("limit"),
    }));
  } catch (error) {
    return errorResponse(error, locale);
  }
}
