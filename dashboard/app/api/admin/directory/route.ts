import { ApiError, errorResponse, json, requireAdminSession } from "@/lib/api";
import { getBotToken } from "@/lib/env";
import { BoundedAsyncCache } from "@/lib/bounded-cache";

type Entry = { id: string; name: string; type?: number };
const cache = new BoundedAsyncCache<Entry[]>(100, 60_000);

export async function GET(req: Request) {
  try {
    await requireAdminSession();
    const q = new URL(req.url).searchParams;
    const guildId = q.get("guildId"), after = q.get("after");
    if ([guildId, after].some(value => value && !/^\d{1,20}$/.test(value))) throw new ApiError(400, "IDの形式が不正です");
    const token = getBotToken();
    if (!token) throw new ApiError(503, "サーバー名の取得に必要なBot接続が未設定です。IDで指定できます。");
    const path = guildId ? `/guilds/${guildId}/channels` : `/users/@me/guilds?limit=200${after ? `&after=${after}` : ""}`;
    const entries = await cache.get(path, async () => {
      const response = await fetch(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${token}` }, cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new ApiError(response.status === 429 ? 429 : 503, "名前の候補を取得できません。時間をおいて再試行するか、IDで指定してください。");
      const rows = await response.json() as Entry[];
      return rows.map(({ id, name, type }) => ({ id, name, ...(type === undefined ? {} : { type }) }));
    });
    return json({ items: entries, nextCursor: !guildId && entries.length === 200 ? entries[entries.length - 1].id : null });
  } catch (error) { return errorResponse(error); }
}
