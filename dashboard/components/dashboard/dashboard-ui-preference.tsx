"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { DashboardLocale } from "@/lib/i18n";
import type { DashboardUIVersion } from "./dashboard-ui-provider";
import "./dashboard-ui-preference.css";

export function DashboardUIPreference({ version, locale }: { version: DashboardUIVersion; locale: DashboardLocale }) {
  const ja = locale === "ja";
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const enabled = version === "preview";
  const busy = saving || refreshing;

  async function changeVersion() {
    if (busy) return;
    setSaving(true); setError(null);
    const nextVersion = enabled ? "legacy" : "preview";
    try {
      const response = await fetch("/api/me/dashboard-ui", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ version: nextVersion }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.version !== nextVersion) throw new Error("Preference was not confirmed");
      startTransition(() => router.refresh());
    } catch {
      setError(ja ? "切り替えられませんでした。もう一度お試しください。" : "Could not switch the dashboard. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return <div className="dashboard-ui-preference" data-dashboard-ui-preference>
    <div className="dashboard-ui-preference-inner">
      <div className="dashboard-ui-preference-description"><strong>{ja ? "新しいダッシュボード" : "New dashboard"}</strong><span>{enabled ? ja ? "いつでも旧画面に戻せます" : "You can return to the old view anytime" : ja ? "新しい画面を試せます。いつでも元に戻せます" : "Try the new view. You can switch back anytime"}</span></div>
      <button type="button" role="switch" aria-checked={enabled} aria-label={ja ? "新しいダッシュボードを使う" : "Use the new dashboard"} disabled={busy} onClick={() => { void changeVersion(); }}>
        <span className="dashboard-ui-preference-track" aria-hidden><span /></span>
        <span>{busy ? ja ? "切り替え中…" : "Switching…" : enabled ? ja ? "旧画面に戻す" : "Return to old view" : ja ? "新しい画面を試す" : "Try the new view"}</span>
      </button>
      {error ? <p role="alert">{error}</p> : busy ? <span role="status" className="sr-only">{ja ? "画面を切り替えています" : "Switching dashboard view"}</span> : null}
    </div>
  </div>;
}
