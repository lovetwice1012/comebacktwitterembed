"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { createTranslator, type DashboardLocale } from "@/lib/i18n";

export function CleanupExpiredButton({ guildId, locale }: { guildId: string; locale: DashboardLocale }) {
  const t = createTranslator(locale);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function cleanup() {
    setBusy(true);
    try {
      await fetch(`/api/guilds/${guildId}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cleanupExpired" }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button onClick={cleanup} disabled={busy} variant="outline">
      <Trash2 size={16} />
      {busy ? t("media.cleanupBusy") : t("media.cleanup")}
    </Button>
  );
}
