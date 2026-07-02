import { errorResponse, json, requireAdminSession } from "@/lib/api";
import { getAdminOverview } from "@/lib/admin-data";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";

export async function GET(req: Request) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    await requireAdminSession(locale);
    return json(await getAdminOverview());
  } catch (error) {
    return errorResponse(error, locale);
  }
}
