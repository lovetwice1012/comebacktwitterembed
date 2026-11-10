"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type Metric = { count: number; failures: number; p95UpperMs: number | null; overLastBucket: number };
type Snapshot = { scope: "current_process"; uptimeSeconds: number; database: Metric; databasePool?: { available: boolean; total: number | null; busy: number | null; waiting: number | null; limit: number | null }; api: Record<string, Metric> };
type API = (path: string, method?: string, body?: unknown) => Promise<any>;
const labels: Record<string, string> = { monitors: "通知一覧・設定", x: "X通知", billing: "支払い・支援", plans: "プラン", history: "履歴", other: "その他" };
const p95 = (value: Metric) => value.count === 0 ? "データなし" : value.p95UpperMs === null ? "30秒超" : `${value.p95UpperMs}ms以下`;
function isMetric(value: any): value is Metric {
  return value && Number.isSafeInteger(value.count) && value.count >= 0 && Number.isSafeInteger(value.failures) && value.failures >= 0 && value.failures <= value.count
    && (value.p95UpperMs === null || Number.isFinite(value.p95UpperMs) && value.p95UpperMs >= 0) && Number.isSafeInteger(value.overLastBucket) && value.overLastBucket >= 0;
}
function parseSnapshot(value: any): Snapshot {
  if (!value || value.scope !== "current_process" || !Number.isSafeInteger(value.uptimeSeconds) || value.uptimeSeconds < 0
    || !isMetric(value.database) || !value.api || typeof value.api !== "object" || Array.isArray(value.api)
    || Object.keys(labels).some(key => !isMetric(value.api[key]))) throw new Error("Invalid performance snapshot");
  return value;
}

export function PerformanceSummary({ api }: { api: API }) {
  const [data, setData] = useState<Snapshot | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const alive = useRef(true), busy = useRef(false), version = useRef(0);
  useEffect(() => { alive.current = true; busy.current = false; setData(null); setError(""); setLoading(false); return () => { alive.current = false; busy.current = false; version.current++; }; }, [api]);
  async function load() {
    if (busy.current) return;
    busy.current = true; const current = ++version.current;
    setLoading(true); setError("");
    try { const next = parseSnapshot(await api("performance")); if (alive.current && version.current === current) setData(next); }
    catch { if (alive.current && version.current === current) setError("運用状況を取得できませんでした。"); }
    finally { if (version.current === current) { busy.current = false; if (alive.current) setLoading(false); } }
  }
  return <section aria-label="画面の処理状況" className="space-y-3 rounded-xl border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">画面の処理状況</h2><Button type="button" variant="outline" disabled={loading} onClick={() => void load()}>{data ? "数値を更新" : "数値を確認"}</Button></div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {data ? <><p className="text-xs text-muted-foreground">この画面サーバーの起動後からの累計です。ブラウザーでの表示時間は含みません。</p>
      {data.databasePool?.available && [data.databasePool.total, data.databasePool.busy, data.databasePool.waiting, data.databasePool.limit].every(value => Number.isSafeInteger(value) && Number(value) >= 0) ? <p className="text-sm">DB接続 {data.databasePool.total} / {data.databasePool.limit} · 使用中 {data.databasePool.busy} · 待機 {data.databasePool.waiting}</p> : null}
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>処理</th><th>件数</th><th>失敗</th><th>95%の応答時間</th></tr></thead><tbody>
        <tr><th>DB問い合わせ</th><td>{data.database.count}</td><td>{data.database.failures}</td><td>{p95(data.database)}</td></tr>
        {Object.entries(labels).map(([key, label]) => data.api[key] ? <tr key={key}><th>{label}</th><td>{data.api[key].count}</td><td>{data.api[key].failures}</td><td>{p95(data.api[key])}</td></tr> : null)}
      </tbody></table></div></> : null}
  </section>;
}
