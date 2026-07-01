import { errorResponse, json, requireGuildPermission } from "@/lib/api";
import { getProvidersOverview } from "@/lib/settings-db";

type Params = { params: Promise<{ guildId: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const { guildId } = await params;
    await requireGuildPermission(guildId, "view");
    return json(await getProvidersOverview(guildId));
  } catch (error) {
    return errorResponse(error);
  }
}
