"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { resultLabels, updateAdminLocation, type RecordSource } from "@/lib/admin-workspace";
import { RawEvidence } from "@/components/admin/evidence-view";

type Data = Record<string, unknown>;
const obj = (v: unknown): Data => v && typeof v === "object" && !Array.isArray(v) ? v as Data : {};
const str = (v: unknown) => v == null || v === "" ? "未記録" : typeof v === "object" ? JSON.stringify(v) : String(v);
const date = (v: unknown) => v && Number.isFinite(new Date(v as string).getTime()) ? new Date(v as string).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "未記録";
const stageLabels: Record<string, string> = { fetch: "外部コンテンツ取得", http: "外部API通信", parse: "応答の解析", settings: "設定判定", send: "Discordへの送信", queue: "実行待ち", "request.started": "処理を受付", "request.completed": "処理が終了", "http.started": "外部APIへ接続", "http.completed": "外部APIから応答" };
export function investigationSummary(value: unknown) {
  const row = obj(value), payload = obj(row.payload), input = obj(row.input), result = obj(row.result), details = obj(payload.details ?? row.details ?? result.details);
  const events = Array.isArray(row.events) ? row.events.map(e => { const item = obj(e); return obj(item.payload ?? item); }) : [];
  const start = events.find(e => e.kind === "request.started") || input;
  const end = [...events].reverse().find(e => e.kind === "request.completed") || obj(row.completion ?? result);
  const endDetails = obj(end.details);
  const merged = { ...start, ...payload, ...row };
  const error = obj(end.error ?? endDetails.error ?? row.error ?? details.error);
  const outcome = String(row.outcome ?? row.status ?? end.outcome ?? endDetails.outcome ?? payload.outcome ?? "");
  const duration = row.durationMs ?? end.durationMs ?? endDetails.durationMs ?? details.durationMs;
  const reason = row.reason ?? end.reason ?? endDetails.reason ?? error.message ?? details.reason ?? row.title;
  return {
    id: str(row.id ?? row.runId ?? row.event_id), time: date(row.firstAt ?? row.createdAt ?? row.occurredAt ?? payload.occurredAt),
    provider: str(merged.provider ?? merged.providerId ?? merged.provider_id ?? input.providerId),
    url: str(merged.url ?? merged.inputUrl ?? input.url ?? obj(merged.input).url ?? merged.messageId ?? merged.message_id ?? row.title ?? row.type ?? row.kind),
    guildId: str(merged.guildId ?? merged.guild_id ?? input.guildId), channelId: str(merged.channelId ?? merged.channel_id ?? input.channelId),
    result: resultLabels[outcome] || outcome || "未確定", outcome,
    stage: str(row.failureStage ?? end.failureStage ?? endDetails.failureStage ?? details.stage ?? row.stage),
    reason: str(reason), duration: typeof duration === "number" ? `${(duration / 1000).toFixed(2)} 秒` : "未計測", events,
  };
}
export function InvestigationList({ items, source, onOpen, selected }: { items: unknown[]; source: RecordSource; onOpen: (id: string, source: RecordSource, item: unknown) => void; selected?: string }) {
  if (!items.length) return <p className="py-5 text-sm text-muted-foreground">該当する記録はありません。記録がないことだけでは、当時の処理が正常だったとは判断できません。</p>;
  return <><div className="space-y-3 md:hidden">{items.map((item, i) => { const summary = investigationSummary(item); return <article key={`${summary.id}-${i}`} className={`space-y-2 rounded-lg border p-3 ${selected === summary.id ? "bg-muted" : ""}`}><div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{summary.result}</span><Button size="sm" variant="outline" aria-label={`${summary.id} の詳細`} onClick={() => onOpen(summary.id, source, item)}>詳細</Button></div><p className="break-all text-sm">{summary.url}</p><p className="text-sm">{summary.reason}</p><p className="text-xs text-muted-foreground">{summary.time} / {summary.duration}</p></article>; })}</div><div className="hidden overflow-x-auto rounded-lg border md:block"><table className="w-full text-left text-sm"><thead className="bg-muted text-muted-foreground"><tr>{["日時・対象", "結果", "失敗段階・理由", "所要時間", ""].map((label, i) => <th key={i} scope="col" className="whitespace-nowrap px-3 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{items.map((item, i) => {
    const summary = investigationSummary(item);
    return <tr key={`${summary.id}-${i}`} className={`border-t align-top ${selected === summary.id ? "bg-muted" : "hover:bg-muted/40"}`}><td className="min-w-48 max-w-md space-y-1 px-3 py-3"><p className="text-xs text-muted-foreground">{summary.time}</p><p className="break-all font-medium">{summary.url}</p><p className="text-xs text-muted-foreground">{summary.provider !== "未記録" ? `${summary.provider} / ` : ""}{summary.guildId !== "未記録" ? `サーバー ${summary.guildId}` : "サービス全体"}</p></td><td className="px-3 py-3"><span className={`inline-block whitespace-nowrap rounded px-2 py-1 text-xs ${["E", "P", "U", "X", "failed"].includes(summary.outcome) ? "bg-destructive/10 text-destructive" : "bg-muted"}`}>{summary.result}</span></td><td className="min-w-40 max-w-sm break-words px-3 py-3"><p>{summary.reason}</p>{summary.stage !== "未記録" ? <p className="mt-1 text-xs text-muted-foreground">{stageLabels[summary.stage] || summary.stage}</p> : null}</td><td className="whitespace-nowrap px-3 py-3 text-xs">{summary.duration}</td><td className="px-3 py-3"><Button className="whitespace-nowrap" size="sm" variant="outline" aria-label={`${summary.id} の詳細`} onClick={() => onOpen(summary.id, source, item)}>詳細</Button></td></tr>;
  })}</tbody></table></div></>;
}
export function InvestigationDetails({ value, loading, error, onClose }: { value: unknown; loading?: boolean; error?: string; onClose: () => void }) {
  const summary = investigationSummary(value);
  return <aside aria-label="事象の詳細" className="min-w-0 space-y-4 rounded-lg border bg-card p-4 xl:sticky xl:top-24 xl:max-h-[calc(100vh-7rem)] xl:overflow-y-auto"><div className="flex items-center justify-between gap-2"><h2 className="text-lg font-semibold">事象の詳細</h2><Button variant="outline" size="sm" onClick={onClose}>閉じる</Button></div>{loading ? <p role="status">処理経過を取得中…</p> : error ? <p role="alert" className="text-destructive">{error}</p> : <>
    <div className="space-y-2"><p className="font-medium">{summary.result} — {summary.reason}</p><p className="break-all text-sm">{summary.url}</p><p className="text-xs text-muted-foreground">{summary.time} JST / {summary.duration}</p></div>
    <div className="rounded bg-muted p-3 text-sm"><p className="font-medium">確認できたこと</p><p>{summary.reason !== "未記録" ? summary.reason : "理由の要約は記録されていません。各段階の証拠を確認してください。"}</p>{summary.stage !== "未記録" ? <p>失敗段階: {stageLabels[summary.stage] || summary.stage}</p> : null}<p className="mt-2 text-muted-foreground">未確認の項目は原文から確認します。記録にない原因は推測しません。</p></div>
    <div className="flex flex-wrap gap-2">{summary.guildId !== "未記録" ? <Button size="sm" variant="outline" onClick={() => updateAdminLocation({ section: "servers", tab: "settings", guildId: summary.guildId, provider: summary.provider !== "未記録" ? summary.provider : "twitter" })}>このサーバーの設定</Button> : null}<Button size="sm" variant="outline" disabled={!/^https?:\/\//.test(summary.url)} onClick={() => updateAdminLocation({ section: "investigation", tab: "inspect", inspectUrl: summary.url })}>URLを検証</Button></div>
    {summary.events.length ? <div><h3 className="mb-3 font-medium">処理の経過</h3><ol className="space-y-3">{summary.events.map((event, i) => { const details = obj(event.details); return <li key={i} className="border-l-2 pl-3"><p className="text-sm font-medium">{i + 1}. {stageLabels[String(event.stage ?? event.kind)] || str(event.stage ?? event.kind)}</p><p className="text-xs text-muted-foreground">{date(event.occurredAt ?? event.occurred_at)} / {str(event.kind)}</p>{details.reason || event.outcome ? <p className="mt-1 text-sm">{str(details.reason ?? resultLabels[String(event.outcome)] ?? event.outcome)}</p> : null}<div className="mt-2"><RawEvidence value={event} label="この段階の証拠" /></div></li>; })}</ol></div> : null}
    <RawEvidence value={value} label="全項目・原文を確認" />
  </>}</aside>;
}

export function OperationsOverview({ api, onOpen }: { api: (path: string) => Promise<Data>; onOpen: (id: string, source: RecordSource, item: unknown) => void }) {
  const [data, setData] = useState<Record<string, { items: unknown[]; error?: string }>>({});
  const [loading, setLoading] = useState(true), [revision, setRevision] = useState(0), [updated, setUpdated] = useState("");
  useEffect(() => {
    let cancelled = false; setLoading(true);
    const paths = { incidents: "incidents?status=active&limit=5", runs: "runs?problematic=1&limit=5", queued: "actions?status=queued&limit=5", running: "actions?status=running&limit=5" };
    Promise.all(Object.entries(paths).map(async ([key, path]) => { try { const value = await api(path); return [key, { items: Array.isArray(value.items) ? value.items : [] }] as const; } catch (e) { return [key, { items: [], error: e instanceof Error ? e.message : "取得失敗" }] as const; } })).then(entries => { if (!cancelled) { setData(Object.fromEntries(entries)); setUpdated(new Date().toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo" })); setLoading(false); } });
    return () => { cancelled = true; };
  }, [api, revision]);
  return <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">対応が必要なこと</h2><p className="mt-1 text-sm text-muted-foreground">サービス全体 / 最近の失敗は直近24時間{updated ? ` / 更新 ${updated} JST` : ""}</p></div><Button variant="outline" disabled={loading} onClick={() => setRevision(v => v + 1)}>{loading ? "取得中…" : "状態を更新"}</Button></div>{[
    ["incidents", "未解決の障害", "incidents"], ["runs", "最近の失敗・一部成功", "runs"], ["running", "実行中の操作", "actions"], ["queued", "受付済みの操作", "actions"],
  ].map(([key, title, source]) => <Card key={key}><CardHeader className="flex-row items-center justify-between gap-2"><CardTitle>{title}</CardTitle><Button size="sm" variant="outline" onClick={() => updateAdminLocation({ section: "investigation", tab: source === "incidents" ? "incidents" : "search", source: source as RecordSource, outcome: key === "runs" ? "D,P,E,U,X" : "", guildId: "", channelId: "", userId: "", messageId: "", from: "", to: "", selected: "" })}>一覧へ</Button></CardHeader><CardContent>{loading ? <p role="status" className="text-sm">取得中…</p> : data[key]?.error ? <p role="alert" className="text-sm text-destructive">{data[key].error}</p> : data[key]?.items.length ? <InvestigationList items={data[key].items} source={source as RecordSource} onOpen={onOpen} /> : <p className="text-sm text-muted-foreground">該当する記録はありません。</p>}</CardContent></Card>)}</div>;
}
