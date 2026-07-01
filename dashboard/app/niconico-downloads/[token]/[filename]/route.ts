import { serveCachedMedia } from "@/lib/media-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string; filename: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { token } = await params;
  return serveCachedMedia("niconico", token);
}
