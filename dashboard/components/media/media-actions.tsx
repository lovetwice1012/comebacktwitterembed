"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CleanupExpiredButton({ guildId }: { guildId: string }) {
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
      {busy ? "cleanup中" : "期限切れをcleanup"}
    </Button>
  );
}

export function DeleteProviderCacheButton({ guildId, providerId }: { guildId: string; providerId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function run() {
    if (!confirm(`${providerId} のcacheを削除します。`)) return;
    setBusy(true);
    try {
      await fetch(`/api/guilds/${guildId}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "deleteProvider", providerId }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button onClick={run} disabled={busy} variant="destructive" size="sm">
      <Trash2 size={15} />
      provider cache削除
    </Button>
  );
}

export function DeleteTokenCacheButton({ guildId, providerId, token }: { guildId: string; providerId: string; token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function run() {
    if (!confirm(`token ${token} を削除します。`)) return;
    setBusy(true);
    try {
      await fetch(`/api/guilds/${guildId}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "deleteToken", providerId, token }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button onClick={run} disabled={busy} variant="ghost" size="icon" title="Delete cache item">
      <Trash2 size={15} />
    </Button>
  );
}
