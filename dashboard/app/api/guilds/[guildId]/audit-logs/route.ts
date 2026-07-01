import { NextRequest } from "next/server";
import { errorResponse, json, requireGuildPermission } from "@/lib/api";
import { listAuditLogs } from "@/lib/audit-log";

type Params = { params: Promise<{ guildId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { guildId } = await params;
    await requireGuildPermission(guildId, "manage");
    const search = req.nextUrl.searchParams;
    return json(await listAuditLogs(guildId, {
      provider_id: search.get("provider_id") || undefined,
      setting_key: search.get("setting_key") || undefined,
      actor_user_id: search.get("actor_user_id") || undefined,
      action: search.get("action") || undefined,
      date_from: search.get("date_from") || undefined,
      date_to: search.get("date_to") || undefined,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
