import { NextRequest } from "next/server";
import { errorResponse, json, requestMeta, requireGuildPermission } from "@/lib/api";
import { resetProviderSettings } from "@/lib/settings-db";

type Params = { params: Promise<{ guildId: string; providerId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { guildId, providerId } = await params;
    const { session } = await requireGuildPermission(guildId, "manage");
    const result = await resetProviderSettings(guildId, providerId, {
      id: session.user.id,
      username: session.user.globalName || session.user.username,
    }, requestMeta(req));
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
