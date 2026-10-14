import { errorResponse, json, requireSession } from "@/lib/api";
import { listNotificationDestinationGuilds, listVisibleGuilds } from "@/lib/discord";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";

export async function GET(req: Request) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    const session = await requireSession(locale);
    if (new URL(req.url).searchParams.get("purpose") === "notification-destinations") {
      let response: Response;
      try {
        response = json(await listNotificationDestinationGuilds(session));
      } catch {
        response = json({ error: "通知先のサーバー一覧を再取得してください。Discordへの接続を確認してから、もう一度お試しください。", code: "DESTINATION_GUILDS_UNAVAILABLE" }, 503);
      }
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    }
    return json(await listVisibleGuilds(session));
  } catch (error) {
    return errorResponse(error, locale);
  }
}
