"use client";

import { AlertTriangle, Check, LockKeyhole, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { createTranslator, type DashboardLocale } from "@/lib/i18n";

export function CleanupExpiredButton({ guildId, locale, canClean = false }: { guildId: string; locale: DashboardLocale; canClean?: boolean }) {
  const t = createTranslator(locale), ja = locale === "ja", router = useRouter();
  const [busy, setBusy] = useState(false), [result, setResult] = useState<{ text: string; error: boolean } | null>(null);
  const running = useRef(false);
  async function cleanup() {
    if (!canClean || running.current) return;
    if (!confirm(ja ? "全サーバー共通の期限切れメディアを削除します。削除したファイルは元に戻せません。続けますか？" : "Delete expired media shared across all servers? Deleted files cannot be restored.")) return;
    running.current = true; setBusy(true); setResult(null);
    try {
      const response = await fetch(`/api/guilds/${guildId}/media`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cleanupExpired" }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setResult({ error: true, text: response.status === 403 ? ja ? "削除にはサーバーの管理者権限が必要です。" : "Server Administrator permission is required to delete media." : ja ? "削除結果を確認できませんでした。容量を再確認してください。" : "Could not confirm deletion. Check storage again." });
        return;
      }
      if (!payload?.cleanup || typeof payload.cleanup !== "object") throw new Error("unconfirmed");
      const counts = Object.values(payload.cleanup);
      if (!counts.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) throw new Error("unconfirmed");
      const count = (counts as number[]).reduce((total, value) => total + value, 0);
      setResult({ error: false, text: ja ? `期限切れメディアを${count}件削除しました。` : `Deleted ${count} expired media items.` });
      router.refresh();
    } catch { setResult({ error: true, text: ja ? "削除結果を確認できませんでした。容量を再確認してください。" : "Could not confirm deletion. Check storage again." }); }
    finally { running.current = false; setBusy(false); }
  }
  return <div className="space-y-2"><Button onClick={cleanup} disabled={busy || !canClean} variant="outline"><Trash2 size={16} aria-hidden />{busy ? t("media.cleanupBusy") : t("media.cleanup")}</Button>
    {!canClean ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><LockKeyhole size={14} aria-hidden />{ja ? "削除には管理者権限が必要" : "Administrator permission required"}</p> : null}
    {result ? <p role={result.error ? "alert" : "status"} className={`flex items-start gap-2 text-sm ${result.error ? "text-destructive" : "text-muted-foreground"}`}>{result.error ? <AlertTriangle size={15} className="shrink-0" aria-hidden /> : <Check size={15} className="shrink-0" aria-hidden />}{result.text}</p> : null}
  </div>;
}
