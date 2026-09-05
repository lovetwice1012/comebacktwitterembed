import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse, requireAdminSession } from "@/lib/api";
import { requestAgentRecovery, validateRecoveryRequest } from "@/lib/admin-agent-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminSession();
    const ownerId = process.env.ADMIN_OWNER_ID || "796972193287503913";
    if (session.user.id !== ownerId) throw new ApiError(403, "この復旧操作は所有者だけが実行できます。");
    const origin = req.headers.get("origin");
    const expected = new URL(process.env.NEXTAUTH_URL || req.url).origin;
    if (!origin || (origin !== expected && origin !== req.nextUrl.origin)) throw new ApiError(403, "Same-origin request required");
    if (!req.headers.get("content-type")?.startsWith("application/json")) throw new ApiError(415, "JSON required");
    if (Number(req.headers.get("content-length") || 0) > 4096) throw new ApiError(413, "復旧操作の入力が上限を超えています。");
    const raw = await req.text();
    if (Buffer.byteLength(raw) > 4096) throw new ApiError(413, "復旧操作の入力が上限を超えています。");
    let request;
    try { request = validateRecoveryRequest(JSON.parse(raw), ownerId); }
    catch (error) { throw new ApiError(400, error instanceof Error ? error.message : "Invalid recovery request"); }
    try {
      const result = await requestAgentRecovery(request);
      return NextResponse.json({ id: request.id, type: request.type, ...result, source: "independent_executor", checkedAt: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return NextResponse.json({ id: request.id, type: request.type, ok: false, state: "unconfirmed", error: error instanceof Error ? error.message : String(error), source: "independent_executor" }, { status: 503, headers: { "cache-control": "no-store" } });
    }
  } catch (error) { return errorResponse(error); }
}
