import { errorResponse, json, requireSession } from "@/lib/api";
import { listVisibleGuilds } from "@/lib/discord";

export async function GET() {
  try {
    const session = await requireSession();
    return json(await listVisibleGuilds(session));
  } catch (error) {
    return errorResponse(error);
  }
}
