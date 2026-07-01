import { errorResponse, json, requireGuildPermission } from "@/lib/api";
import { catalogForGuild } from "@/lib/settings-db";

type Params = { params: Promise<{ guildId: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const { guildId } = await params;
    await requireGuildPermission(guildId, "view");
    return json({ providers: catalogForGuild() });
  } catch (error) {
    return errorResponse(error);
  }
}
