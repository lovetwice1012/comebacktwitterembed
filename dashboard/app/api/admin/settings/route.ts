import { NextRequest } from "next/server";
import { errorResponse, json, requestMeta, requireAdminSession } from "@/lib/api";
import { getAdminGuildSettings, saveAdminGuildSettings } from "@/lib/admin-data";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";

export async function GET(req: NextRequest) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    await requireAdminSession(locale);
    const search = req.nextUrl.searchParams;
    return json(await getAdminGuildSettings(String(search.get("guild_id") || ""), String(search.get("provider_id") || ""), locale));
  } catch (error) {
    return errorResponse(error, locale);
  }
}

export async function PATCH(req: NextRequest) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    const session = await requireAdminSession(locale);
    const body = await req.json();
    return json(await saveAdminGuildSettings(
      body,
      {
        id: session.user.id,
        username: `admin:${session.user.globalName || session.user.username || session.user.id}`,
      },
      requestMeta(req),
      locale,
    ));
  } catch (error) {
    return errorResponse(error, locale);
  }
}
