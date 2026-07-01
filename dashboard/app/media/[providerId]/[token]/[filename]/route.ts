import { serveCachedMedia } from "@/lib/media-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ providerId: string; token: string; filename: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { providerId, token } = await params;
  return serveCachedMedia(providerId, token);
}
