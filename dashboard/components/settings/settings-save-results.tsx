"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, LoaderCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DashboardLocale } from "@/lib/i18n";
import type { SettingValue } from "@/lib/types";
import { deepEqual } from "@/lib/settings-diff";

export type SettingsTarget = { guildId: string; name: string };
export type SettingsResult = SettingsTarget & { status: "saving" | "saved" | "failed"; error?: string; warnings: string[]; confirmed?: Record<string, SettingValue>; operationKey?: string; outcomeUnknown?: boolean };
export type SettingsPlan = { label: string; kind: "preset" | "provider"; targets: SettingsTarget[]; providerId?: string; changes: Record<string, SettingValue> };

export function useSettingsBatch(locale: DashboardLocale, scopeKey: string) {
  const [plan, setPlan] = useState<SettingsPlan | null>(null), [results, setResults] = useState<SettingsResult[]>([]), [busy, setBusy] = useState(false);
  const running = useRef(false);
  const generation = useRef(0);
  useEffect(() => { generation.current++; running.current = false; setPlan(null); setResults([]); setBusy(false); }, [scopeKey]);
  async function run(nextPlan: SettingsPlan, retry = false) {
    if (running.current) return results;
    const prior = results;
    const operationKey = nextPlan.kind === "provider" ? `provider:${nextPlan.providerId}` : "preset";
    const confirmedFor = (target: SettingsTarget) => { const previous = prior.find(result => result.guildId === target.guildId); return previous?.operationKey === operationKey ? previous.confirmed || {} : {}; };
    const satisfied = (target: SettingsTarget) => {
      const previous = prior.find(result => result.guildId === target.guildId);
      const confirmed = confirmedFor(target);
      return previous?.status === "saved" && Object.entries(nextPlan.changes).every(([key, value]) => Object.hasOwn(confirmed, key) && deepEqual(confirmed[key], value));
    };
    const targets = retry ? nextPlan.targets.filter(target => prior.some(result => result.guildId === target.guildId && result.status === "failed")) : nextPlan.targets.filter(target => !satisfied(target));
    if (!targets.length) return nextPlan.targets.map(target => prior.find(result => result.guildId === target.guildId)!);
    running.current = true; setBusy(true); setPlan(nextPlan);
    const epoch = generation.current;
    const pendingIds = new Set(targets.map(target => target.guildId));
    setResults(nextPlan.targets.map(target => pendingIds.has(target.guildId) ? { ...target, status: "saving", warnings: [] } : prior.find(result => result.guildId === target.guildId)!));
    try {
      const nextResults = await Promise.all(targets.map(async target => {
        let result: SettingsResult;
        const fallback = locale === "ja" ? "保存できませんでした。接続と権限を確認して再試行してください。" : "Could not save. Check your connection and permissions, then retry.";
        try {
          const path = nextPlan.kind === "preset" ? "providers/bulk" : `providers/${nextPlan.providerId}/settings`;
          const response = await fetch(`/api/guilds/${target.guildId}/${path}`, { method: nextPlan.kind === "preset" ? "POST" : "PATCH", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ changes: nextPlan.changes }) });
          const payload = await response.json().catch(() => null);
          if (!response.ok || !payload || typeof payload !== "object") result = { ...target, status: "failed", warnings: [], error: typeof payload?.error === "string" ? payload.error : fallback, operationKey, confirmed: Object.fromEntries(Object.entries(confirmedFor(target)).filter(([key]) => !Object.hasOwn(nextPlan.changes, key))), outcomeUnknown: response.ok || response.status >= 500 };
          else result = { ...target, status: "saved", warnings: Array.isArray(payload.warnings) ? payload.warnings.filter((warning: unknown): warning is string => typeof warning === "string") : [], operationKey, confirmed: { ...confirmedFor(target), ...structuredClone(nextPlan.changes) } };
        } catch { result = { ...target, status: "failed", warnings: [], error: locale === "ja" ? "保存結果を確認できませんでした。現在の値で再試行してください。" : "Could not confirm the save. Retry with the current values.", operationKey, confirmed: Object.fromEntries(Object.entries(confirmedFor(target)).filter(([key]) => !Object.hasOwn(nextPlan.changes, key))), outcomeUnknown: true }; }
        if (epoch === generation.current) setResults(current => current.map(item => item.guildId === target.guildId ? result : item));
        return result;
      }));
      if (epoch !== generation.current) return [];
      return nextPlan.targets.map(target => nextResults.find(result => result.guildId === target.guildId) || prior.find(result => result.guildId === target.guildId)!);
    } finally { if (epoch === generation.current) { running.current = false; setBusy(false); } }
  }
  return { plan, results, busy, run };
}

export function SettingsSaveResults({ label, results, busy, locale, onRetry, retryAllowed = true }: { label: string; results: SettingsResult[]; busy: boolean; locale: DashboardLocale; onRetry: () => void; retryAllowed?: boolean }) {
  if (!results.length) return null;
  const ja = locale === "ja", saved = results.filter(result => result.status === "saved").length, failed = results.filter(result => result.status === "failed").length;
  return <section aria-label={ja ? "サーバー別の保存結果" : "Save results by server"} className="space-y-3 rounded-md border bg-card p-4">
    <h3 className="text-sm font-semibold">{label}</h3>
    <p role="status" className="text-sm">{ja ? `保存済み ${saved}件 失敗 ${failed}件` : `${saved} saved, ${failed} failed`}</p>
    <ul className="space-y-2">{results.map(result => <li key={result.guildId} className="rounded-md border p-3 text-sm">
      <div className="flex items-start gap-2">{result.status === "saved" ? <Check size={16} className="mt-0.5 shrink-0 text-green-700" aria-hidden="true" /> : result.status === "failed" ? <AlertTriangle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" /> : <LoaderCircle size={16} className="mt-0.5 shrink-0 animate-spin" aria-hidden="true" />}<span className="min-w-0 flex-1 break-words font-medium">{result.name}</span><span>{result.status === "saved" ? ja ? "保存済み" : "Saved" : result.outcomeUnknown ? ja ? "結果不明" : "Unconfirmed" : result.status === "failed" ? ja ? "失敗" : "Failed" : ja ? "保存中" : "Saving"}</span></div>
      {result.error && <p role="alert" className="mt-2 text-destructive">{result.error}</p>}
      {result.warnings.map(warning => <p key={warning} className="mt-2 text-muted-foreground">{warning}</p>)}
    </li>)}</ul>
    {failed > 0 && <><Button className="min-h-11" variant="outline" disabled={busy || !retryAllowed} onClick={onRetry}><RotateCcw size={16} aria-hidden="true" />{ja ? "失敗したサーバーだけ再試行" : "Retry failed servers"}</Button>{!retryAllowed && <p className="text-xs text-muted-foreground">{ja ? "変更内容が変わりました。編集中の変更を保存してください。" : "Your edits changed. Save the current changes."}</p>}</>}
  </section>;
}
