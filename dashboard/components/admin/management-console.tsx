"use client";

import Link from "next/link";
import { AgentRecoveryPanel } from "@/components/admin/agent-recovery-panel";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";

type Data = Record<string, unknown>;
type Action = { id: string; type: string; status: string; input?: Data; result?: unknown; data?: unknown; error?: unknown; createdAt?: string; updatedAt?: string };
type CatalogAction = { type: string; label?: string; description?: string; inputExample?: Data; mutating?: boolean };
type Tab = "search" | "inspect" | "send" | "settings" | "operations" | "incidents" | "metrics" | "policies";
const tabs: [Tab, string][] = [["search", "事象・履歴"], ["inspect", "URL実行検証"], ["send", "指定先へ送信"], ["settings", "設定確認・変更"], ["operations", "管理操作"], ["incidents", "障害・診断"], ["metrics", "稼働・影響"], ["policies", "監視・自動修復"]];
const selectClass = "h-10 w-full rounded-md border bg-card px-3 text-sm";
const obj = (value: unknown): Data => value && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const pretty = (value: unknown) => JSON.stringify(value ?? null, null, 2);
const text = (value: unknown) => value == null ? "未取得" : typeof value === "object" ? pretty(value) : String(value);
const date = (value: unknown) => value == null ? "未取得" : new Date(typeof value === "number" ? value : String(value)).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
const safeUrl = (value: unknown) => { try { const u = new URL(String(value)); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password ? u.href : undefined; } catch { return undefined; } };
function parseObject(value: string, label: string): Data { const result = JSON.parse(value || "{}"); if (!result || Array.isArray(result) || typeof result !== "object") throw new Error(`${label} はJSONオブジェクトにしてください`); return result; }
function jstIso(value: string) { if (!value) return undefined; const d = new Date(`${value}:00+09:00`); if (!Number.isFinite(d.getTime())) throw new Error("日時が不正です"); return d.toISOString(); }

async function api<T = Data>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api/admin/agent/${path}`, { method, credentials: "same-origin", cache: "no-store", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  if (!response.ok) { const e = obj(value.error); throw Object.assign(new Error(text(e.message ?? value.error ?? response.status)), { status: response.status, independentUrl: value.independentUrl }); }
  return value as T;
}

export function RawEvidence({ value, label = "全項目・原文", expanded = false }: { value: unknown; label?: string; expanded?: boolean }) {
  const [filter, setFilter] = useState("");
  const [feedback, setFeedback] = useState("");
  const raw = pretty(value);
  const displayed = filter ? raw.split("\n").filter(line => line.toLowerCase().includes(filter.toLowerCase())).join("\n") : raw;
  return <details open={expanded} className="rounded-md border p-3"><summary className="cursor-pointer text-sm font-medium">{label}</summary><div className="mt-3 space-y-2">
    <div className="flex flex-wrap gap-2"><Input className="max-w-xs" aria-label="原文検索" placeholder="原文を検索" value={filter} onChange={e => setFilter(e.target.value)} /><Button variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(raw); setFeedback("コピーしました"); } catch { setFeedback("コピーできません。原文を選択してください。"); } }}>全体をコピー</Button><Button variant="outline" onClick={() => { const u = URL.createObjectURL(new Blob([raw], { type: "application/json" })); const a = document.createElement("a"); a.href = u; a.download = "admin-evidence.json"; a.click(); URL.revokeObjectURL(u); }}>JSON保存</Button></div>
    {feedback ? <p className="text-xs">{feedback}</p> : null}<pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{displayed || "一致なし"}</pre>
  </div></details>;
}

function Field({ label, value, onChange, placeholder = "", type = "text" }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return <label className="block space-y-1 text-sm"><span>{label}</span><Input type={type} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} /></label>;
}

function OutputPreview({ value }: { value: unknown }) {
  const steps = list(value);
  if (!steps.length) return <p className="text-sm text-muted-foreground">生成された送信ステップはありません。判定結果とAPI応答を確認してください。</p>;
  return <div className="space-y-3">{steps.map((step, i) => {
    const s = obj(step); const p = obj(s.payload ?? s.options ?? s.data ?? step); const embeds = list(p.embeds);
    return <div className="rounded border bg-muted/30 p-4" key={i}><p className="mb-2 text-xs text-muted-foreground">送信 {i + 1} / {text(s.type ?? s.kind ?? "message")}</p>
      {p.content ? <p className="whitespace-pre-wrap break-words text-sm">{text(p.content)}</p> : null}
      {embeds.map((entry, n) => { const e = obj(entry); const image = safeUrl(obj(e.image).url); return <div className="my-2 rounded border-l-4 bg-card p-3" key={n} style={{ borderLeftColor: typeof e.color === "number" ? `#${e.color.toString(16).padStart(6, "0")}` : undefined }}>
        {e.title ? <p className="font-semibold">{safeUrl(e.url) ? <a href={safeUrl(e.url)} target="_blank" rel="noreferrer" className="underline">{text(e.title)}</a> : text(e.title)}</p> : null}
        {e.description ? <p className="whitespace-pre-wrap break-words text-sm">{text(e.description)}</p> : null}
        {list(e.fields).map((f, k) => <div className="mt-2 text-sm" key={k}><strong>{text(obj(f).name)}</strong><p className="whitespace-pre-wrap">{text(obj(f).value)}</p></div>)}
        {image ? <a href={image} target="_blank" rel="noreferrer" className="mt-2 block"><img src={image} alt={String(e.title || "展開画像")} loading="lazy" className="max-h-80 max-w-full rounded object-contain" referrerPolicy="no-referrer" /></a> : null}
      </div>; })}
      {p.files ? <RawEvidence value={p.files} label="添付ファイル" /> : null}{p.components ? <RawEvidence value={p.components} label="ボタン・コンポーネント" /> : null}<RawEvidence value={step} label="送信payload全文" />
    </div>;
  })}</div>;
}

function SettingValueEditor({ snapshot, settingKey, value, onKey, onValue }: { snapshot: Data | null; settingKey: string; value: string; onKey: (v: string) => void; onValue: (v: string) => void }) {
  const values = obj(snapshot?.settings); const defaults = obj(snapshot?.defaults); const spec = list(snapshot?.specs).map(obj).find(row => (row.key ?? row.settingKey) === settingKey); const choices = list(spec?.choices);
  const current = values[settingKey];
  return <div className="space-y-3"><label className="block text-sm">設定項目<select className={selectClass} value={settingKey} onChange={e => { onKey(e.target.value); onValue(pretty(values[e.target.value])); }}><option value="">変更する項目を選択</option>{Object.keys(values).sort().map(key => <option key={key} value={key}>{key}</option>)}</select></label>
    {settingKey ? <><p className="text-sm">現在値: <code>{pretty(current)}</code> / 既定値: <code>{pretty(defaults[settingKey])}</code></p>{choices.length ? <label className="block text-sm">変更後の値<select className={selectClass} value={value} onChange={e => onValue(e.target.value)}>{choices.map((item, i) => <option key={i} value={pretty(obj(item).value)}>{text(obj(obj(item).label).ja ?? obj(item).label ?? obj(item).value)}</option>)}</select></label> : typeof current === "boolean" ? <label className="block text-sm">変更後の値<select className={selectClass} value={value} onChange={e => onValue(e.target.value)}><option value="true">有効（true）</option><option value="false">無効（false）</option></select></label> : typeof current === "number" ? <Field label="変更後の数値" type="number" value={value} onChange={onValue} /> : typeof current === "string" ? <Field label="変更後の文字列" value={(() => { try { return String(JSON.parse(value)); } catch { return value; } })()} onChange={v => onValue(JSON.stringify(v))} /> : <label className="block text-sm">変更後の一覧・対象（JSON）<Textarea rows={6} className="font-mono" value={value} onChange={e => onValue(e.target.value)} /></label>}</> : null}
  </div>;
}

function ActionResult({ action, onOpen }: { action: Action; onOpen?: (id: string) => void }) {
  const result = obj(action.result ?? action.data); const attempts = list(result.httpAttempts); const steps = result.steps ?? result.planned_outputs; const deliverySteps = list(result.steps).filter(step => obj(step).messageId || obj(step).error);
  return <Card><CardHeader><CardTitle>実行結果: {action.status}</CardTitle><CardDescription>{action.type} / {action.id} / {date(action.createdAt)} JST</CardDescription></CardHeader><CardContent className="space-y-3">
    {action.error || result.error ? <div role="alert" className="rounded border border-destructive p-3"><pre className="whitespace-pre-wrap break-all text-sm">{pretty(action.error ?? result.error)}</pre></div> : null}
    {result.outcome ? <p className="font-medium">判定: {text(result.outcome)} {result.reason ? ` / 理由: ${text(result.reason)}` : ""}</p> : null}{result.context ? <RawEvidence value={result.context} label="使用したサーバー・権限・未評価条件" /> : null}
    {steps ? <div className="grid gap-4 xl:grid-cols-2"><div><h3 className="mb-2 font-semibold">展開結果（Discord表示の参考）</h3><OutputPreview value={steps} /></div><div className="space-y-2"><h3 className="font-semibold">外部APIの試行と応答</h3>{attempts.length ? attempts.map((attempt, i) => <RawEvidence key={i} value={attempt} label={`${i + 1}. ${text(obj(attempt).method ?? "GET")} ${text(obj(attempt).url)} / HTTP ${text(obj(attempt).status)}`} />) : <p className="text-sm">HTTP試行の記録なし。キャッシュ・保存応答の利用・取得前の失敗は原文を確認してください。</p>}</div></div> : null}
    {result.sourcePolicy ? <RawEvidence value={result.sourcePolicy} label="使用した取得元ポリシー" /> : null}
    {result.plannedEffects ? <RawEvidence value={result.plannedEffects} label="予定された後処理・設定による変更" /> : null}
    {[...list(result.messages), ...deliverySteps].map((m, i) => { const row = obj(m); const u = safeUrl(row.url ?? row.jumpUrl); return <p key={i}>送信済みID: {text(row.id ?? row.messageId)} {u ? <a href={u} target="_blank" rel="noreferrer" className="underline">Discordで開く</a> : null}</p>; })}
    {result.baseline && result.candidate ? <div className="grid gap-3 xl:grid-cols-2"><div><h3 className="mb-2 font-semibold">変更前: {text(obj(result.baseline).outcome)}</h3><OutputPreview value={obj(result.baseline).steps} /><RawEvidence value={obj(result.baseline).settings} label="変更前の設定" /></div><div><h3 className="mb-2 font-semibold">変更後: {text(obj(result.candidate).outcome)}</h3><OutputPreview value={obj(result.candidate).steps} /><RawEvidence value={obj(result.candidate).settings} label="変更後の設定" /></div></div> : null}
    {list(result.events).length ? <div className="rounded border p-3"><h3 className="mb-2 font-semibold">処理経過</h3>{list(result.events).map((event, i) => { const row = obj(event); return <div className="my-2 border-l-2 pl-3" key={i}><p className="text-sm">{text(row.stage)} / {text(row.kind)} / {text(obj(row.details).reason ?? obj(row.details).outcome ?? "")}</p><RawEvidence value={event} label="この段階の証拠" /></div>; })}</div> : null}
    <RawEvidence value={action} label="実行履歴・入力・設定・API応答・エラーの全項目" />{onOpen ? <Button variant="outline" onClick={() => onOpen(action.id)}>最新状態を取得</Button> : null}
  </CardContent></Card>;
}

export function ManagementConsole({ initialTab = "search", standalone = false }: { initialTab?: Tab; standalone?: boolean }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [health, setHealth] = useState<Data | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingSubmission, setPendingSubmission] = useState<{ type: string; input: Data; idempotencyKey: string } | null>(null);
  const [catalog, setCatalog] = useState<CatalogAction[]>([]);
  const [guildId, setGuild] = useState(""); const [channelId, setChannel] = useState(""); const [userId, setUser] = useState("");
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [url, setUrl] = useState(""); const [sourceId, setSourceId] = useState("default"); const [sourceFallback, setSourceFallback] = useState("default"); const [settingsText, setSettingsText] = useState("{}"); const [candidateText, setCandidateText] = useState("{}");
  const [action, setAction] = useState<Action | null>(null); const [baseline, setBaseline] = useState<Data | null>(null);
  const [history, setHistory] = useState<unknown[]>([]); const [nextCursor, setNextCursor] = useState<string | null>(null); const [source, setSource] = useState("runs"); const [appliedSearch, setAppliedSearch] = useState("");
  const [detail, setDetail] = useState<unknown>(null);
  const [sendMode, setSendMode] = useState("manual"); const [content, setContent] = useState(""); const [payloadText, setPayloadText] = useState("{}"); const [replyTo, setReplyTo] = useState(""); const [resolved, setResolved] = useState<Data | null>(null);
  const [provider, setProvider] = useState("twitter"); const [settingResult, setSettingResult] = useState<Data | null>(null); const [settingKey, setSettingKey] = useState(""); const [settingValue, setSettingValue] = useState("true"); const [sourceGuild, setSourceGuild] = useState("");
  const [operationType, setOperationType] = useState(""); const [operationInput, setOperationInput] = useState("{}");
  const [metricData, setMetricData] = useState<Data | null>(null); const [policies, setPolicies] = useState<Data | null>(null); const [policyText, setPolicyText] = useState("{}");
  const [password, setPassword] = useState(""); const [passwordAgain, setPasswordAgain] = useState(""); const [accountMessage, setAccountMessage] = useState("");

  const refreshConnection = useCallback(async () => { try { const [h, c] = await Promise.all([api("health"), api<{ actions: CatalogAction[] }>("catalog")]); setHealth(h); setCatalog(c.actions || []); setConnectionError(""); } catch (e) { setConnectionError(text(e instanceof Error ? e.message : e)); const independentUrl = (e as { independentUrl?: string }).independentUrl; if (independentUrl) setHealth({ independentUrl }); } }, []);
  useEffect(() => { void refreshConnection(); }, [refreshConnection]);
  useEffect(() => { if (tab !== "metrics" || !health?.ok || metricData) return; let cancelled = false; api("metrics").then(data => { if (!cancelled) setMetricData(data); }).catch(e => { if (!cancelled) setError(text(e.message)); }); return () => { cancelled = true; }; }, [tab, health, metricData]);
  useEffect(() => { setResolved(null); }, [guildId, channelId, replyTo]);
  useEffect(() => { setSettingResult(null); setSettingKey(""); }, [guildId, provider]);
  const openAction = useCallback(async (id: string) => { const a = await api<Action>(`actions/${encodeURIComponent(id)}`); setAction(a); return a; }, []);
  useEffect(() => {
    if (!action || !["queued", "running"].includes(action.status)) return;
    let cancelled = false;
    const timer = setTimeout(() => { api<Action>(`actions/${encodeURIComponent(action.id)}`).then(a => { if (!cancelled) setAction(a); }).catch(e => { if (!cancelled) setError(`結果の取得に失敗しました。操作ID ${action.id}: ${text(e.message)}`); }); }, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [action]);
  useEffect(() => {
    if (action?.status !== "succeeded") return;
    const result = obj(action.result ?? action.data);
    if (["url.inspect", "url.reparse"].includes(action.type)) setBaseline(result);
    if (action.type === "message.resolve" && action.input?.guildId === guildId && action.input?.channelId === channelId && (action.input?.replyTo || "") === replyTo) setResolved(result);
    if (action.type.startsWith("settings.") && action.type !== "settings.catalog" && action.input?.guildId === guildId && action.input?.providerId === provider) setSettingResult(result);
  }, [action, guildId, channelId, replyTo, provider]);

  async function perform(fn: () => Promise<unknown>) { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(text(e instanceof Error ? e.message : e)); } finally { setBusy(false); } }
  async function submit(type: string, input: Data) {
    const idempotencyKey = crypto.randomUUID();
    // Display the key before dispatch; an ambiguous response must be investigated rather than retried as a new operation.
    setDetail({ submittedType: type, idempotencyKey, submittedAt: new Date().toISOString(), input });
    const request = { type, input, idempotencyKey }; setPendingSubmission(request);
    try { const a = await api<Action>("actions", "POST", request); setAction(a); setPendingSubmission(null); } catch (e) { const status = (e as { status?: number }).status; if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) setPendingSubmission(null); throw e; }
  }
  function context(): Data { return { ...(guildId ? { guildId: guildId.trim() } : {}), ...(channelId ? { channelId: channelId.trim() } : {}), ...(userId ? { userId: userId.trim() } : {}) }; }
  function query(cursor?: string, outcome?: string) { const q = new URLSearchParams({ limit: "100" }); if (guildId) q.set("guildId", guildId.trim()); const start = jstIso(from); const end = jstIso(to); if (start) q.set("from", start); if (end) q.set("to", end); if (start && end && start >= end) throw new Error("終了日時は開始日時より後にしてください"); if (cursor) q.set("cursor", cursor); if (outcome) q.set("outcome", outcome); return q; }
  async function search(cursor?: string, selected = source, outcome?: string) { const q = cursor && appliedSearch ? new URLSearchParams(appliedSearch) : query(undefined, outcome); if (cursor) q.set("cursor", cursor); else setAppliedSearch(q.toString()); const data = await api(`${selected}?${q}`); setHistory(prev => cursor ? [...prev, ...list(data.items)] : list(data.items)); setNextCursor(data.nextCursor ? String(data.nextCursor) : null); setDetail(data.metadata ?? data.coverage ?? null); }
  async function inspect(kind: "url.inspect" | "url.reparse" | "url.compare") { if (!safeUrl(url)) throw new Error("http(s)のURLを指定してください"); await submit(kind, { ...context(), url, ...(/https?:\/\/(?:www\.)?(?:x|twitter|fxtwitter|vxtwitter)\.com\//i.test(url) ? { sourceId, ...(sourceFallback === "default" ? {} : { sourceFallback: sourceFallback === "true" }) } : {}), settings: kind === "url.inspect" ? parseObject(settingsText, "設定") : { ...obj(baseline?.settings), ...parseObject(settingsText, "設定") }, ...(kind !== "url.inspect" ? { httpAttempts: baseline?.httpAttempts, baselineSettings: baseline?.settings, candidateSettings: { ...obj(baseline?.settings), ...parseObject(candidateText, "比較設定") }, context: baseline?.context } : {}) }); }
  async function send() {
    if (!resolved) throw new Error("先に送信先を確認してください");
    const input: Data = { ...context(), guildId, channelId, mode: sendMode, ...(replyTo ? { replyTo } : {}), purpose: "admin_operation" };
    if (sendMode === "manual") input.payload = { ...parseObject(payloadText, "payload"), content, allowedMentions: { parse: [] } };
    if (sendMode === "url") input.url = url;
    if (sendMode === "captured") { if (!baseline) throw new Error("URL実行検証を先に実行してください"); input.steps = baseline.steps; }
    await submit("message.send", input);
  }
  function canSubmit() { return !busy && !pendingSubmission && !["queued", "running"].includes(action?.status || ""); }

  return <div className={standalone ? "mx-auto min-h-screen max-w-[1600px] space-y-4 bg-background p-4 md:p-6" : "space-y-4"}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl font-semibold">管理サポートコンソール</h1><p className="text-sm text-muted-foreground">サーバーIDと時間帯から調査・設定変更・復旧確認。管理デーモンと履歴を共有します。</p></div><div className="flex gap-2"><Link href="/admin" className="rounded border px-3 py-2 text-sm">従来の分析・設定</Link><Button variant="outline" onClick={() => void refreshConnection()}>接続確認</Button>{safeUrl(health?.independentUrl) ? <a className="rounded border px-3 py-2 text-sm" href={safeUrl(health?.independentUrl)} target="_blank" rel="noreferrer">独立管理Web</a> : null}</div></div>
    {connectionError ? <div role="alert" className="rounded border border-destructive p-3 text-sm">{connectionError} この画面の停止後も受付済み操作は管理デーモンで継続します。再接続後に履歴を確認してください。</div> : <p className="text-xs text-muted-foreground">管理デーモン {health ? "接続済み" : "接続確認中"} / 時刻: {date(health?.time)} JST</p>}
    <details open={Boolean(connectionError)} className="rounded border p-3"><summary className="mb-2 cursor-pointer text-sm font-medium">管理デーモンの独立確認・復旧</summary><AgentRecoveryPanel onRecovered={refreshConnection} /></details>
    <nav className="flex flex-wrap gap-2">{tabs.map(([key, label]) => <Button variant={tab === key ? "default" : "outline"} key={key} onClick={() => { setTab(key); if (key === "incidents") { setSource("incidents"); setHistory([]); setNextCursor(null); } setError(""); }}>{label}</Button>)}</nav>
    <Card><CardContent className="grid gap-3 pt-5 md:grid-cols-3"><Field label="サーバーID" value={guildId} onChange={setGuild} placeholder="例: 123456789012345678" /><Field label="チャンネルID" value={channelId} onChange={setChannel} placeholder="調査・送信対象（必要な操作のみ）" /><Field label="対象ユーザーID" value={userId} onChange={setUser} placeholder="設定判定対象（省略時は未評価）" /></CardContent></Card>
    {error ? <p role="alert" className="rounded border border-destructive p-3 text-sm">{error}</p> : null}
    {pendingSubmission ? <div className="rounded border p-3 text-sm"><p>操作の受付結果を確認中です。新しい操作IDでは再実行しません。キー: {pendingSubmission.idempotencyKey}</p><Button variant="outline" disabled={busy} onClick={() => void perform(async () => { const a = await api<Action>("actions", "POST", pendingSubmission); setAction(a); setPendingSubmission(null); })}>同じ受付キーで結果を確認</Button></div> : null}

    {tab === "search" || tab === "incidents" ? <Card><CardHeader><CardTitle>{tab === "incidents" ? "障害・診断・通知" : "事象・操作履歴"}</CardTitle><CardDescription>日時はJST。記録なしと未取得を区別し、各行から原文と処理経過を確認します。</CardDescription></CardHeader><CardContent className="space-y-4"><div className="grid gap-3 md:grid-cols-4"><Field label="開始（含む）" type="datetime-local" value={from} onChange={setFrom} /><Field label="終了（含まない）" type="datetime-local" value={to} onChange={setTo} /><label className="space-y-1 text-sm"><span>記録種別</span><select className={selectClass} value={source} onChange={e => { setSource(e.target.value); setHistory([]); setNextCursor(null); }}><option value="runs">処理要求</option><option value="events">段階別の証拠</option><option value="actions">管理操作</option><option value="incidents">障害・診断</option><option value="notifications">通知</option></select></label><Button className="self-end" disabled={busy} onClick={() => void perform(() => search())}>検索</Button></div>
      {history.map((item, i) => { const r = obj(item); const id = text(r.id ?? r.runId ?? r.traceId ?? r.event_id); return <div key={`${id}-${i}`} className="rounded border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="break-all text-sm">{date(r.createdAt ?? r.occurredAt ?? r.occurred_at_ms)} / {text(r.type ?? r.kind ?? r.stage)} / {text(r.status ?? r.outcome)} / {id}</p>{["actions", "runs", "incidents"].includes(source) && id !== "未取得" ? <Button variant="outline" onClick={() => void perform(async () => { if (source === "actions") await openAction(id); else setDetail(await api(`${source}/${encodeURIComponent(id)}`)); })}>処理経過を開く</Button> : null}</div><RawEvidence value={item} /></div>; })}
      {!history.length ? <p className="text-sm text-muted-foreground">取得した記録はありません。検索結果が0件でも、当時の記録・受信が完全だったとは限りません。</p> : null}{nextCursor ? <Button disabled={busy} variant="outline" onClick={() => void perform(() => search(nextCursor))}>次の100件を追加</Button> : null}
    </CardContent></Card> : null}

    {tab === "inspect" ? <Card><CardHeader><CardTitle>URL実行検証</CardTitle><CardDescription>実際の取得元から取得し、展開payloadとHTTP応答を保存します。検証は診断用途として通常利用統計から分離され、Discordへ投稿しません。</CardDescription></CardHeader><CardContent className="space-y-4"><Field label="検証するURL" value={url} onChange={setUrl} placeholder="https://..." />{/https?:\/\/(?:www\.)?(?:x|twitter|fxtwitter|vxtwitter)\.com\//i.test(url) ? <div className="flex flex-wrap items-end gap-3"><label className="text-sm">Xの取得元<select className={selectClass} value={sourceId} onChange={e => setSourceId(e.target.value)}><option value="default">稼働中の設定を使用</option><option value="vxtwitter">vxtwitter</option><option value="fxtwitter">fxtwitter</option></select></label><label className="text-sm">別の取得元への切り替え<select className={selectClass} value={sourceFallback} onChange={e => setSourceFallback(e.target.value)}><option value="default">稼働中の設定を使用</option><option value="true">許可する</option><option value="false">許可しない</option></select></label></div> : null}<div className="grid gap-3 md:grid-cols-2"><label className="text-sm">設定上書き（省略した値はサーバー設定）<Textarea rows={5} className="mt-1 font-mono" value={settingsText} onChange={e => setSettingsText(e.target.value)} /></label><label className="text-sm">同じ保存応答と比較する設定<Textarea rows={5} className="mt-1 font-mono" value={candidateText} onChange={e => setCandidateText(e.target.value)} /></label></div><div className="flex flex-wrap gap-2"><Button disabled={!canSubmit()} onClick={() => void perform(() => inspect("url.inspect"))}>実際に取得して展開</Button><Button variant="outline" disabled={!canSubmit() || !baseline} onClick={() => void perform(() => inspect("url.reparse"))}>保存応答を再解析</Button><Button variant="outline" disabled={!canSubmit() || !baseline} onClick={() => void perform(() => inspect("url.compare"))}>同じ応答で設定比較</Button><Button variant="outline" disabled={!baseline} onClick={() => { setSendMode("captured"); setTab("send"); }}>この出力を指定先へ送る</Button></div></CardContent></Card> : null}

    {tab === "send" ? <Card><CardHeader><CardTitle>サーバー・チャンネル指定送信</CardTitle><CardDescription>送信先を照合後、明示的に送信します。URL取得・手入力・検証済み出力に対応し、API応答と各メッセージIDを記録します。</CardDescription></CardHeader><CardContent className="space-y-4"><div className="grid gap-3 md:grid-cols-2"><label className="text-sm">送信内容<select value={sendMode} onChange={e => setSendMode(e.target.value)} className={selectClass}><option value="manual">手入力の本文・Embed・添付</option><option value="url">URLを取得して展開</option><option value="captured">URL検証で確認した出力</option></select></label><Field label="返信先メッセージID（任意）" value={replyTo} onChange={setReplyTo} /></div>
      {sendMode === "manual" ? <><label className="block text-sm">本文<Textarea rows={5} value={content} onChange={e => setContent(e.target.value)} /></label><label className="block text-sm">Embed・添付等のpayload（JSON / embeds, files, components）<Textarea rows={7} className="font-mono" value={payloadText} onChange={e => setPayloadText(e.target.value)} /></label><p className="text-xs text-muted-foreground">メンションは既定で通知しません。添付は管理workerが受け付けるHTTPS URLを指定してください。</p></> : sendMode === "url" ? <Field label="展開するURL" value={url} onChange={setUrl} /> : <OutputPreview value={baseline?.steps} />}
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!canSubmit() || !guildId || !channelId} onClick={() => void perform(() => submit("message.resolve", { guildId, channelId, ...(replyTo ? { replyTo } : {}) }))}>サーバー・チャンネルと権限を確認</Button><Button disabled={!canSubmit() || !resolved} onClick={() => void perform(send)}>確認した送信先へ送信</Button></div>{resolved ? <RawEvidence value={resolved} label="照合した送信先・権限" expanded /> : null}</CardContent></Card> : null}

    {tab === "settings" ? <Card><CardHeader><CardTitle>サーバー設定</CardTitle><CardDescription>全設定の現在値と既定値を取得し、変更・復元・コピーの結果とBotが使う設定版を確認します。</CardDescription></CardHeader><CardContent className="space-y-4"><div className="flex flex-wrap items-end gap-3"><Field label="プロバイダー" value={provider} onChange={setProvider} /><Button disabled={!canSubmit()} onClick={() => void perform(() => submit("settings.get", { guildId, providerId: provider }))}>現在の設定を取得</Button><Button variant="outline" disabled={!canSubmit()} onClick={() => void perform(() => submit("settings.catalog", {}))}>全項目の説明・型を取得</Button></div>
      {settingResult ? <RawEvidence value={settingResult} label="設定値・既定値・説明・版の全項目" expanded /> : null}<SettingValueEditor snapshot={settingResult} settingKey={settingKey} value={settingValue} onKey={setSettingKey} onValue={setSettingValue} /><div className="flex flex-wrap gap-2"><Button disabled={!canSubmit() || !settingResult || !settingKey} onClick={() => void perform(() => submit("settings.change", { guildId, providerId: provider, key: settingKey, value: JSON.parse(settingValue), expectedHash: settingResult?.settingsHash ?? settingResult?.hash }))}>変更して反映を確認</Button><Button variant="outline" disabled={!canSubmit() || !settingResult || !settingKey} onClick={() => void perform(() => submit("settings.reset", { guildId, providerId: provider, key: settingKey, expectedHash: settingResult?.settingsHash ?? settingResult?.hash }))}>指定キーを既定値へ戻す</Button></div><div className="flex flex-wrap items-end gap-3"><Field label="コピー元サーバーID" value={sourceGuild} onChange={setSourceGuild} /><Button variant="outline" disabled={!canSubmit() || !settingResult || !sourceGuild} onClick={() => void perform(() => submit("settings.copy", { guildId, sourceGuildId: sourceGuild, providerId: provider, expectedHash: settingResult?.settingsHash ?? settingResult?.hash }))}>現在のサーバーへコピー</Button></div><p className="text-xs text-muted-foreground">変更履歴は「事象・履歴」の管理操作から確認できます。従来の設定フォームも /admin のサポートタブから利用できます。</p></CardContent></Card> : null}

    {tab === "operations" ? <Card><CardHeader><CardTitle>管理操作カタログ</CardTitle><CardDescription>自動展開、保存データ、容量、委任アクセス、再取得、削除、診断・修復など、稼働中workerが提供する操作を実行します。</CardDescription></CardHeader><CardContent className="space-y-4"><select aria-label="管理操作" className={selectClass} value={operationType} onChange={e => { setOperationType(e.target.value); const selected = catalog.find(item => item.type === e.target.value); setOperationInput(pretty({ ...selected?.inputExample, ...context() })); }}><option value="">操作を選択</option>{catalog.map(item => <option value={item.type} key={item.type}>{item.label || item.type} {item.mutating ? "（変更操作）" : ""}</option>)}</select><p className="text-sm">{catalog.find(item => item.type === operationType)?.description}</p><label className="block text-sm">入力（選択すると必要な項目の例を表示）<Textarea rows={12} className="font-mono" value={operationInput} onChange={e => setOperationInput(e.target.value)} /></label><Button disabled={!canSubmit() || !operationType} onClick={() => void perform(() => submit(operationType, parseObject(operationInput, "操作入力")))}>選択した操作を実行</Button><RawEvidence value={catalog} label="利用可能な全操作と入出力仕様" /></CardContent></Card> : null}

    {tab === "metrics" ? <Card><CardHeader><CardTitle>要求単位の稼働・影響</CardTitle><CardDescription>根要求を一件として集計。閲覧・既読・リンククリックはDiscord APIから取得できず、統計へ含めません。分母・対象期間・観測状態を併記します。</CardDescription></CardHeader><CardContent className="space-y-4"><div className="flex flex-wrap items-end gap-3"><Field label="開始（JST）" type="datetime-local" value={from} onChange={setFrom} /><Field label="終了（JST）" type="datetime-local" value={to} onChange={setTo} /><Button disabled={busy} onClick={() => void perform(async () => setMetricData(await api(`metrics?${query()}`)))}>集計する</Button></div>{metricData ? <MetricsView data={metricData} onDrill={outcome => { setSource("runs"); setTab("search"); void perform(() => search(undefined, "runs", outcome)); }} /> : <p className="text-sm">サーバーと期間を指定して集計してください。過去の旧イベントを要求数へ推定変換しません。</p>}</CardContent></Card> : null}

    {tab === "policies" ? <Card><CardHeader><CardTitle>監視・自動修復ポリシー</CardTitle><CardDescription>LLMを使わず診断ルールと証拠で判定します。適用済みの版を指定して更新し、競合を防ぎます。</CardDescription></CardHeader><CardContent className="space-y-4"><Button variant="outline" disabled={busy} onClick={() => void perform(async () => { const p = await api("policies"); setPolicies(p); setPolicyText(pretty(p)); })}>現在のポリシーを取得</Button><Textarea aria-label="監視ポリシーJSON" rows={15} className="font-mono" value={policyText} onChange={e => setPolicyText(e.target.value)} /><Button disabled={busy || !policies} onClick={() => void perform(async () => { const p = await api("policies", "PUT", { ...parseObject(policyText, "ポリシー"), expectedRevision: policies?.revision }); setPolicies(p); setPolicyText(pretty(p)); })}>ポリシーを更新</Button>{policies ? <RawEvidence value={policies} label="適用されたポリシー" /> : null}</CardContent></Card> : null}

    {tab === "policies" ? <Card><CardHeader><CardTitle>独立管理Webのログイン</CardTitle><CardDescription>通常ダッシュボードやDiscord OAuthが停止した場合に使う管理者パスワードを設定します。管理デーモンの接続トークンをブラウザーへ渡しません。</CardDescription></CardHeader><CardContent className="space-y-3"><div className="grid gap-3 md:grid-cols-2"><Field label="新しい管理者パスワード" type="password" value={password} onChange={setPassword} /><Field label="新しいパスワード（再入力）" type="password" value={passwordAgain} onChange={setPasswordAgain} /></div><Button disabled={busy || !password || password !== passwordAgain} onClick={() => void perform(async () => { await api("account/password", "POST", { password }); setPassword(""); setPasswordAgain(""); setAccountMessage("独立管理Webのパスワードを更新しました。"); })}>パスワードを設定</Button>{accountMessage ? <p role="status" className="text-sm">{accountMessage}</p> : null}</CardContent></Card> : null}
    {action ? <ActionResult action={action} onOpen={id => void perform(() => openAction(id))} /> : null}
    {detail ? <RawEvidence value={detail} label="選択した事象・実行受付の詳細" /> : null}
  </div>;
}

function MetricsView({ data, onDrill }: { data: Data; onDrill: (outcome?: string) => void }) {
  const outcomes = obj(data.outcomes); const labels = obj(data.outcomeLabels); const success = obj(data.fullSuccess); const coverage = obj(data.coverage);
  const cards: { label: string; value: string; note: string; outcome?: string }[] = [
    { label: "展開要求数", value: text(data.requestCount), note: "根要求IDで重複排除。引用・再試行は加算しません。" },
    { label: "完全成功を確認できた割合", value: success.ratio == null ? "対象なし" : `${(Number(success.ratio) * 100).toFixed(2)}%`, note: `${text(success.numerator)} / ${text(success.denominator)} 要求（F / F+D+P+E+U+X）`, outcome: "F" },
    { label: "問題のある要求", value: text(data.problemRequestCount), note: "代替・部分成功・失敗・対象制約・結果不明", outcome: "D,P,E,U,X" },
    { label: "設定による見送り", value: text(data.skippedRequestCount), note: "完全成功率の分母から分離", outcome: "S" },
    { label: "影響サーバー数", value: text(data.affectedGuildCount), note: `問題のある要求のサーバー集合。サーバー不明の要求: ${text(data.affectedUnknownGuildRequests)}`, outcome: "D,P,E,U,X" },
    { label: "未完了の最長経過時間", value: data.oldestUnfinishedAgeMs == null ? "対象なし" : `${(Number(data.oldestUnfinishedAgeMs) / 1000).toFixed(1)}秒`, note: "完了時間の分布には混ぜません", outcome: "I,X" },
  ];
  return <div className="space-y-4"><p className="text-xs text-muted-foreground">{date(data.from)} ～ {date(data.to)} JST（終了を含まない） / 定義 {text(data.definitionVersion)} / 集計時点 {date(data.snapshotAt)}</p><div className="grid gap-3 md:grid-cols-3">{cards.map(card => <button key={card.label} className="rounded border bg-card p-4 text-left" onClick={() => onDrill(card.outcome)}><span className="text-sm">{card.label}</span><p className="my-2 text-2xl font-semibold">{card.value}</p><p className="text-xs text-muted-foreground">{card.note}</p></button>)}</div>
    <div className="rounded border p-3"><p className="font-medium">要求結果の内訳</p><div className="mt-2 flex flex-wrap gap-2">{Object.entries(outcomes).map(([key, value]) => <Button key={key} variant="outline" onClick={() => onDrill(key)}>{text(labels[key] ?? key)}: {text(value)}</Button>)}</div></div>
    <div className="grid gap-3 lg:grid-cols-2"><div className="rounded border p-3"><h3 className="mb-2 font-medium">完了時間（結果別）</h3>{Object.entries(obj(data.latencyByOutcome)).map(([key, value]) => { const row = obj(value); return <p className="mb-2 text-sm" key={key}>{text(labels[key] ?? key)} / {text(row.sampleCount)}件 / P50 {row.p50Ms == null ? "未取得" : `${(Number(row.p50Ms) / 1000).toFixed(3)}秒`} / P95 {row.p95Ms == null ? "未取得" : `${(Number(row.p95Ms) / 1000).toFixed(3)}秒`}</p>; })}<p className="text-xs text-muted-foreground">原データのnearest-rank分位点。対象0件の分位点は未取得です。</p></div><div className="rounded border p-3"><h3 className="mb-2 font-medium">計測状態</h3><p className="text-sm">状態: {text(coverage.state)} / 最初の要求記録: {date(coverage.firstRecordedRequestAt)} / 最新: {date(coverage.latestRecordedRequestAt)}</p><p className="mt-2 text-xs text-muted-foreground">旧記録からの要求結果の復元は行いません。記録されていない期間を成功や0件として判断しないでください。</p><RawEvidence value={{ coverage, excluded: data.excluded }} label="記録状態と診断・管理操作の除外件数" /></div></div>
    <div className="rounded border p-3"><h3 className="mb-2 font-medium">サービス別の結果</h3>{Object.entries(obj(data.byProvider)).map(([provider, value]) => <p className="mb-2 text-sm" key={provider}>{provider}: {Object.entries(obj(value)).map(([outcome, count]) => `${text(labels[outcome] ?? outcome)} ${text(count)}`).join(" / ")}</p>)}</div>
    <Button variant="outline" onClick={() => onDrill()}>この条件の根要求と結果を開く</Button><RawEvidence value={data} label="指標辞書・分子分母・計測状態（全項目）" />
  </div>;
}
