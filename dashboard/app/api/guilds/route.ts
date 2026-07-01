import { errorResponse, json, requireSession } from "@/lib/api";
import { listVisibleGuilds } from "@/lib/discord";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";

export async function GET(req: Request) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    const session = await requireSession(locale);
    return json(await listVisibleGuilds(session));
  } catch (error) {
    return errorResponse(error, locale);
  }
}
