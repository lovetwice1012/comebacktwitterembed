import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { automationServices } from "@/lib/automation-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Square signs the exact bytes and the configured public notification URL.
// This endpoint deliberately has no session or Origin requirement: the shared
// billing module authenticates the event before parsing or reading Square data.
export async function POST(req: NextRequest) {
  try {
    const claimed = req.headers.get("content-length");
    if (claimed !== null && (!/^\d+$/.test(claimed) || Number(claimed) > 256 * 1024)) return json({ error: "通知が大きすぎます。" }, 413);
    const reader = req.body?.getReader();
    if (!reader) return json({ error: "通知の本文がありません。" }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0, timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new Error("Webhook read timeout")); }, 15000);
    });
    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), deadline]);
        if (done) break;
        size += value.byteLength;
        if (size > 256 * 1024) { await reader.cancel(); return json({ error: "通知が大きすぎます。" }, 413); }
        chunks.push(value);
      }
    } finally { clearTimeout(timer!); reader.releaseLock(); }
    const result = await automationServices().billing.handleWebhook(Buffer.concat(chunks), req.headers.get("x-square-hmacsha256-signature") || "");
    const response = json(result);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error: any) {
    const known = error?.name === "AutomationError";
    const response = json({ error: known ? error.message : "決済通知を処理できませんでした。", code: known ? error.code : "SQUARE_WEBHOOK_UNAVAILABLE" }, known ? error.status || 503 : 503);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
