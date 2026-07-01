import { errorResponse, json, requireSession } from "@/lib/api";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";

export async function GET(req: Request) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    const session = await requireSession(locale);
    return json(session.user);
  } catch (error) {
    return errorResponse(error, locale);
  }
}
