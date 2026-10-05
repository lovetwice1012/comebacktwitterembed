"use client";

import { RawEvidence } from "@/components/admin/evidence-view";
export { RawEvidence } from "@/components/admin/evidence-view";
import { EmergencyRecoveryPanel } from "@/components/admin/emergency-recovery-panel";
import { AgentRecoveryPanel } from "@/components/admin/agent-recovery-panel";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { useAdminLocation, updateAdminLocation, buildInvestigationQuery, verifyInvestigationFilters, sectionTabs, resultLabels, type ManagementTab, type RecordSource, type AdminSection } from "@/lib/admin-workspace";
import { InvestigationList, InvestigationDetails, OperationsOverview, investigationSummary } from "@/components/admin/investigation-view";

type Data = Record<string, unknown>;
type Action = { id: string; type: string; status: string; input?: Data; result?: unknown; data?: unknown; error?: unknown; createdAt?: string; updatedAt?: string };
type CatalogAction = { type: string; label?: string; description?: string; inputExample?: Data; mutating?: boolean; available?: boolean; unavailableReason?: string };
type Tab = ManagementTab;
const tabs: [Tab, string][] = [["search", "事象・履歴"], ["inspect", "URL実行検証"], ["send", "指定先へ送信"], ["settings", "設定確認・変更"], ["operations", "管理操作"], ["incidents", "障害・診断"], ["metrics", "稼働・影響"], ["policies", "監視・自動修復"], ["recovery", "緊急復旧"]];
const PENDING_ACTION_KEY = "cbte-admin-pending-action-v1";
const LAST_ACTION_KEY = "cbte-admin-last-action-v1";
function saveSession(key: string, value: unknown) { try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* The daemon remains the durable record; show the receipt key even if browser storage is full. */ } }
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
  let response: Response;
  try { response = await fetch(`/api/admin/agent/${path}`, { method, credentials: "same-origin", cache: "no-store", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000) }); }
  catch (error) { throw new Error(`管理APIへ接続できません。${error instanceof Error ? error.message : String(error)}。受付済みの操作は再送せず同じキーで確認します。`); }
  let value: Data;
  try { value = await response.json(); }
  catch { throw Object.assign(new Error(`管理APIの応答を読み取れません（HTTP ${response.status}）。接続を確認して同じ操作の結果を再取得してください。`), { status: response.status }); }
  if (!response.ok) { const e = obj(value.error); throw Object.assign(new Error(text(e.message ?? value.error ?? response.status)), { status: response.status, independentUrl: value.independentUrl }); }
  return value as T;
}


export function readableHttpBody(attempt: Data) {
  const encoding = String(attempt.bodyEncoding || "utf8");
  if (attempt.body === undefined || attempt.body === null) return { available: false, format: "未取得", text: "本文は記録されていません。未読込・読込失敗・保持期限などを処理経過で確認してください。", encoding };
  if (encoding === "base64") return { available: true, format: "バイナリ（Base64）", text: String(attempt.body), encoding };
  const raw = typeof attempt.body === "string" ? attempt.body : JSON.stringify(attempt.body);
  try { return { available: true, format: "JSON（整形表示）", text: JSON.stringify(JSON.parse(raw), null, 2), encoding }; }
  catch { return { available: true, format: "テキスト原文", text: raw, encoding }; }
}

export function HttpAttemptCard({ value, index }: { value: unknown; index: number }) {
  const attempt = obj(value); const body = useMemo(() => readableHttpBody(attempt), [attempt]);
  const headers = obj(attempt.headers); const error = obj(attempt.error);
  const [copied, setCopied] = useState(false);
  return <article className="space-y-3 rounded border bg-card p-3"><div><h4 className="break-all text-sm font-semibold">{index + 1}. {text(attempt.method || "GET")} {text(attempt.url)}</h4><p className="mt-1 text-sm">HTTP {text(attempt.status)} {text(attempt.statusText || "")} / {text(attempt.durationMs)} ms / {text(attempt.bytes)} bytes</p></div>
    <div className="flex flex-wrap gap-2 text-xs"><span className="rounded border px-2 py-1">{body.format}</span><span className="rounded border px-2 py-1">Encoding: {body.encoding}</span><span className={`rounded border px-2 py-1 ${attempt.truncated ? "border-destructive text-destructive" : ""}`}>{attempt.truncated ? "本文は一部のみ保存" : attempt.bodyState === "complete" ? "本文保存済み" : text(attempt.bodyState)}</span>{attempt.credentialsRedacted ? <span className="rounded border px-2 py-1">資格情報は省略済み</span> : null}{attempt.replayed ? <span className="rounded border px-2 py-1">保存応答の再利用</span> : null}</div>
    {attempt.responseUrl && attempt.responseUrl !== attempt.url ? <p className="break-all text-xs">最終応答URL: {text(attempt.responseUrl)}</p> : null}{headers["content-type"] ? <p className="text-xs">Content-Type: {text(headers["content-type"])}</p> : null}
    {attempt.error ? <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">{text(error.code || error.name || "HTTPエラー")}: {text(error.message)}</p> : null}
    <div><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h5 className="text-sm font-medium">応答本文</h5>{body.available ? <Button variant="outline" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(body.text); setCopied(true); } catch { setCopied(false); } }}>{copied ? "コピー済み" : "表示本文をコピー"}</Button> : null}</div>{body.available && body.encoding === "base64" ? <p className="text-xs text-muted-foreground">バイナリ本文は、下の原記録からBase64として確認・保存できます。</p> : <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{body.text || "（空の本文）"}</pre>}</div>
    <RawEvidence value={{ requestHeaders: attempt.requestHeaders, requestBody: attempt.requestBody, headers: attempt.headers, timeoutMs: attempt.timeoutMs, headersMs: attempt.headersMs, error: attempt.error }} label="リクエスト・ヘッダー・エラー詳細" />
    <RawEvidence value={attempt} label="HTTP試行の原記録（本文を含む全項目）" />
  </article>;
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
  const values = obj(snapshot?.settings), defaults = obj(snapshot?.defaults), specs = list(snapshot?.specs).map(obj);
  const localized = (v: unknown) => typeof v === "string" ? v : text(obj(v).ja ?? obj(v).en);
  const specification = (key: string) => specs.find(row => (row.settingKey ?? row.key) === key);
  const spec = specification(settingKey), choices = list(spec?.choices).map(obj), current = values[settingKey];
  let parsed: unknown; let parseError = "";
  try { parsed = JSON.parse(value); } catch { parseError = "入力したJSONの形式を確認してください"; }
  if (!snapshot) return null;
  return <div className="space-y-3"><label className="block text-sm"><span className="mb-1 block">設定項目</span><select aria-label="設定項目" className={selectClass} value={settingKey} onChange={e => { onKey(e.target.value); onValue(pretty(values[e.target.value])); }}><option value="">変更する項目を選択</option>{Object.keys(values).sort().map(key => <option key={key} value={key}>{specification(key)?.label ? localized(specification(key)?.label) : key} ({key})</option>)}</select></label>
    {settingKey ? <><p className="text-sm text-muted-foreground">{spec?.description ? localized(spec.description) : "この項目の説明は記録されていません。"}</p><p className="text-xs text-muted-foreground">既定値: {pretty(defaults[settingKey])}</p>
    {choices.length && Array.isArray(current) ? <div className="flex flex-wrap gap-3">{choices.map((choice, i) => <label key={i} className="flex gap-2 text-sm"><input type="checkbox" checked={Array.isArray(parsed) && parsed.some(v => String(v) === String(choice.value))} onChange={e => onValue(pretty(e.target.checked ? [...(Array.isArray(parsed) ? parsed : []), choice.value] : (Array.isArray(parsed) ? parsed : []).filter(v => String(v) !== String(choice.value))))} />{localized(choice.label ?? choice.value)}</label>)}</div> : choices.length ? <label className="block text-sm">変更後の値<select className={selectClass} value={value} onChange={e => onValue(e.target.value)}>{choices.map((choice, i) => { const option = typeof current === "number" ? Number(choice.value) : typeof current === "boolean" ? String(choice.value) === "true" : choice.value; return <option key={i} value={pretty(option)}>{localized(choice.label ?? choice.value)}</option>; })}</select></label> : !parseError ? <OperationValueEditor name={settingKey} value={parsed} onChange={v => onValue(pretty(v))} /> : <p role="alert" className="text-sm text-destructive">{parseError}</p>}
    <details className="rounded border p-3"><summary className="cursor-pointer text-sm">JSONで詳細編集</summary><Textarea aria-label="設定値JSON" className="mt-3 font-mono" rows={5} value={value} onChange={e => onValue(e.target.value)} /></details></> : null}
  </div>;
}

function actionStateLabel(value: string) {
  return ({ queued: "受付済み", running: "実行中", succeeded: "完了", failed: "操作に失敗", unknown: "成否未確認" } as Record<string, string>)[value] || "状態の詳細を確認";
}

function outcomeLabel(value: unknown, sending: boolean) {
  return ({ preview_generated: "展開プレビューを生成", failed: sending ? "送信に失敗" : "取得・展開に失敗", skipped: "設定により見送り", no_output_reason_unrecorded: "出力なし（理由の記録なし）", full_success: "予定した出力の送信を確認", partial_success: "一部の出力だけ送信を確認", delivery_unknown: "送信結果を確認できない", not_sent: "未送信", restricted: "取得対象の制約により展開できない", unavailable: "取得対象を利用できない" } as Record<string, string>)[String(value)] || "判定の詳細を確認";
}

function ActionResult({ action, onOpen }: { action: Action; onOpen?: (id: string) => void }) {
  const result = obj(action.result ?? action.data); const attempts = list(result.httpAttempts); const steps = result.steps ?? result.planned_outputs; const deliverySteps = list(result.steps).filter(step => obj(step).messageId || obj(step).error);
  return <Card><CardHeader><CardTitle>操作の完了状態: {actionStateLabel(action.status)}</CardTitle><CardDescription>{action.type} / {action.id} / {date(action.createdAt)} JST</CardDescription></CardHeader><CardContent className="space-y-3">
    {action.error || result.error ? <div role="alert" className="rounded border border-destructive p-3"><pre className="whitespace-pre-wrap break-all text-sm">{pretty(action.error ?? result.error)}</pre></div> : null}
    {result.outcome ? <p className="font-medium">{action.type.startsWith("message.") ? "送信の判定" : "展開の判定"}: {outcomeLabel(result.outcome, action.type.startsWith("message."))} {result.reason ? ` / 理由: ${text(result.reason)}` : ""}</p> : null}{result.context ? <RawEvidence value={result.context} label="使用したサーバー・権限・未評価条件" /> : null}
    {steps ? <div className="grid gap-4 xl:grid-cols-2"><div><h3 className="mb-2 font-semibold">展開結果（Discord表示の参考）</h3><OutputPreview value={steps} /></div><div className="space-y-2"><h3 className="font-semibold">外部APIの試行と応答</h3>{attempts.length ? attempts.map((attempt, i) => <HttpAttemptCard key={i} value={attempt} index={i} />) : <p className="text-sm">HTTP試行の記録なし。キャッシュ・保存応答の利用・取得前の失敗は原文を確認してください。</p>}</div></div> : null}
    {result.sourcePolicy ? <RawEvidence value={result.sourcePolicy} label="使用した取得元ポリシー" /> : null}
    {result.plannedEffects ? <RawEvidence value={result.plannedEffects} label="予定された後処理・設定による変更" /> : null}
    {[...list(result.messages), ...deliverySteps].map((m, i) => { const row = obj(m); const u = safeUrl(row.url ?? row.jumpUrl); return <p key={i}>送信済みID: {text(row.id ?? row.messageId)} {u ? <a href={u} target="_blank" rel="noreferrer" className="underline">Discordで開く</a> : null}</p>; })}
    {result.baseline && result.candidate ? <div className="grid gap-3 xl:grid-cols-2"><div><h3 className="mb-2 font-semibold">変更前: {outcomeLabel(obj(result.baseline).outcome, false)}</h3><OutputPreview value={obj(result.baseline).steps} /><RawEvidence value={obj(result.baseline).settings} label="変更前の設定" /></div><div><h3 className="mb-2 font-semibold">変更後: {outcomeLabel(obj(result.candidate).outcome, false)}</h3><OutputPreview value={obj(result.candidate).steps} /><RawEvidence value={obj(result.candidate).settings} label="変更後の設定" /></div></div> : null}
    {list(result.events).length ? <div className="rounded border p-3"><h3 className="mb-2 font-semibold">処理経過</h3>{list(result.events).map((event, i) => { const row = obj(event); return <div className="my-2 border-l-2 pl-3" key={i}><p className="text-sm">{text(row.stage)} / {text(row.kind)} / {text(obj(row.details).reason ?? obj(row.details).outcome ?? "")}</p><RawEvidence value={event} label="この段階の証拠" /></div>; })}</div> : null}
    <RawEvidence value={action} label="実行履歴・入力・設定・API応答・エラーの全項目" />{onOpen ? <Button variant="outline" onClick={() => onOpen(action.id)}>最新状態を取得</Button> : null}
  </CardContent></Card>;
}

export function ManagementConsole({ standalone = false, active = true }: { initialTab?: Tab; standalone?: boolean; active?: boolean }) {
  const location = useAdminLocation();
  const { tab, guildId, channelId, userId, from, to, source, provider } = location;
  const setTab = (next: Tab) => { const section = (Object.keys(sectionTabs) as AdminSection[]).find(key => sectionTabs[key].includes(next)) || "investigation"; updateAdminLocation({ section, tab: next }); };
  const setSource = (source: string) => updateAdminLocation({ source: source as RecordSource, tab: source === "incidents" ? "incidents" : "search", selected: "" });
  const setProvider = (provider: string) => updateAdminLocation({ provider }, true);
  const [health, setHealth] = useState<Data | null>(null);
  const [connectionError, setConnectionError] = useState(""); const [catalogError, setCatalogError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingSubmission, setPendingSubmission] = useState<{ type: string; input: Data; idempotencyKey: string } | null>(null);
  const [catalog, setCatalog] = useState<CatalogAction[]>([]);
  const [url, setUrl] = useState(""); const [sourceId, setSourceId] = useState("default"); const [sourceFallback, setSourceFallback] = useState("default"); const [settingsText, setSettingsText] = useState("{}"); const [candidateText, setCandidateText] = useState("{}");
  useEffect(() => { if (location.inspectUrl) setUrl(location.inspectUrl); }, [location.inspectUrl]);
  const [action, setAction] = useState<Action | null>(null); const [baseline, setBaseline] = useState<Data | null>(null);
  const [history, setHistory] = useState<unknown[]>([]); const [nextCursor, setNextCursor] = useState<string | null>(null); const [appliedSearch, setAppliedSearch] = useState("");
  const searchVersion = useRef(0);
  const [searchLoading, setSearchLoading] = useState(false), [searchError, setSearchError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState("");
  const [showAction, setShowAction] = useState(false);
  useEffect(() => { setShowAction(false); }, [location.section]);
  const [detail, setDetail] = useState<unknown>(null);
  const [sendMode, setSendMode] = useState("manual"); const [content, setContent] = useState(""); const [payloadText, setPayloadText] = useState("{}"); const [replyTo, setReplyTo] = useState(""); const [resolved, setResolved] = useState<Data | null>(null);
  const [settingResult, setSettingResult] = useState<Data | null>(null); const [settingKey, setSettingKey] = useState(""); const [settingValue, setSettingValue] = useState("true"); const [sourceGuild, setSourceGuild] = useState("");
  const [providerCatalog, setProviderCatalog] = useState<Data[]>([]);
  const [settingConfirmation, setSettingConfirmation] = useState(false);
  const [copyConfirmed, setCopyConfirmed] = useState(false);
  const [resettingSetting, setResettingSetting] = useState(false);
  const [operationType, setOperationType] = useState(""); const [operationInput, setOperationInput] = useState<Data>({}); const [operationConfirmed, setOperationConfirmed] = useState(false);
  const [metricData, setMetricData] = useState<Data | null>(null); const [shardData, setShardData] = useState<Data | null>(null); const [policies, setPolicies] = useState<Data | null>(null); const [policyText, setPolicyText] = useState("{}");
  const [password, setPassword] = useState(""); const [passwordAgain, setPasswordAgain] = useState(""); const [accountMessage, setAccountMessage] = useState("");

  const refreshConnection = useCallback(async () => {
    const [h, c] = await Promise.allSettled([api("health"), api<{ actions: CatalogAction[] }>("catalog")]);
    if (h.status === "fulfilled") { setHealth(h.value); setConnectionError(""); }
    else { const e = h.reason; setConnectionError(text(e instanceof Error ? e.message : e)); const independentUrl = (e as { independentUrl?: string }).independentUrl; setHealth(previous => ({ independentUrl: independentUrl || previous?.independentUrl, ok: false })); }
    if (c.status === "fulfilled") { setCatalog(Array.isArray(c.value.actions) ? c.value.actions : []); setCatalogError(""); }
    else setCatalogError(`操作カタログの取得に失敗しました。URL検証・送信先確認は個別に実行できます。${text(c.reason instanceof Error ? c.reason.message : c.reason)}`);
  }, []);
  useEffect(() => { void refreshConnection(); }, [refreshConnection]);
  useEffect(() => { const timer = setTimeout(() => void refreshConnection(), connectionError || catalogError ? 10000 : 30000); return () => clearTimeout(timer); }, [connectionError, catalogError, refreshConnection, health]);
  useEffect(() => {
    try {
      const pending = JSON.parse(sessionStorage.getItem(PENDING_ACTION_KEY) || "null");
      if (pending && typeof pending.type === "string" && typeof pending.idempotencyKey === "string" && pending.input && typeof pending.input === "object") setPendingSubmission(pending);
      const last = JSON.parse(sessionStorage.getItem(LAST_ACTION_KEY) || "null");
      if (last && typeof last.id === "string" && /^[A-Za-z0-9:_.-]+$/.test(last.id)) setAction({ id: last.id, type: last.type || "前回の操作", status: "running" });
    } catch { /* Malformed browser state never triggers an operation. */ }
  }, []);
  useEffect(() => { if (tab !== "metrics" || !active || !health?.ok) return; let cancelled = false; setMetricData(null); setError(""); try { api(`metrics?${query()}`).then(data => { if (!cancelled) setMetricData(data); }).catch(e => { if (!cancelled) setError(text(e.message)); }); } catch (e) { setError(e instanceof Error ? e.message : "期間を確認してください"); } return () => { cancelled = true; }; }, [tab, active, health?.ok, guildId, from, to]);
  useEffect(() => { if (!["metrics", "home"].includes(tab) || !health?.ok || shardData) return; let cancelled = false; api("shards").then(data => { if (!cancelled) setShardData(data); }).catch(e => { if (!cancelled) setError(text(e.message)); }); return () => { cancelled = true; }; }, [tab, health, shardData]);
  useEffect(() => { setResolved(null); }, [guildId, channelId, replyTo]);
  useEffect(() => { setSettingResult(null); setSettingKey(""); }, [guildId, provider]);
  useEffect(() => { setSettingConfirmation(false); setCopyConfirmed(false); }, [guildId, provider, settingKey, settingValue, sourceGuild, settingResult]);
  useEffect(() => { let cancelled = false; fetch("/api/admin/catalog").then(async response => { if (!response.ok) return; const value = await response.json(); if (!cancelled) setProviderCatalog(Array.isArray(value) ? value : value.providers || []); }).catch(() => {}); return () => { cancelled = true; }; }, []);
  const openAction = useCallback(async (id: string) => { const a = await api<Action>(`actions/${encodeURIComponent(id)}`); setAction(a); saveSession(LAST_ACTION_KEY, { id: a.id, type: a.type }); return a; }, []);
  useEffect(() => {
    if (!action || !["queued", "running"].includes(action.status)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await api<Action>(`actions/${encodeURIComponent(action.id)}`); if (!cancelled) { setAction(next); setError(""); } }
      catch (e) {
        if (cancelled) return;
        if (!((e as { status?: number }).status) || ((e as { status?: number }).status || 0) >= 500) void refreshConnection();
        setError(`結果の取得に失敗しました。操作ID ${action.id}: ${text(e instanceof Error ? e.message : e)}。GETでの確認を再試行します。`);
        if ([401, 403, 404].includes((e as { status?: number }).status || 0)) setAction(current => current?.id === action.id ? { ...current, status: "unknown" } : current);
        else timer = setTimeout(() => void poll(), 8000);
      }
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [action, refreshConnection]);
  useEffect(() => {
    if (action?.status !== "succeeded") return;
    const result = obj(action.result ?? action.data);
    if (["url.inspect", "url.reparse"].includes(action.type)) setBaseline(result);
    if (action.type === "message.resolve" && action.input?.guildId === guildId && action.input?.channelId === channelId && (action.input?.replyTo || "") === replyTo) setResolved(result);
    if (action.type.startsWith("settings.") && action.type !== "settings.catalog" && action.input?.guildId === guildId && action.input?.providerId === provider) setSettingResult(previous => ({ ...previous, ...result }));
  }, [action, guildId, channelId, replyTo, provider]);

  async function perform(fn: () => Promise<unknown>) { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(text(e instanceof Error ? e.message : e)); } finally { setBusy(false); } }
  async function submit(type: string, input: Data) {
    const idempotencyKey = crypto.randomUUID();
    // Display the key before dispatch; an ambiguous response must be investigated rather than retried as a new operation.
    setShowAction(!type.startsWith("settings."));
    const request = { type, input, idempotencyKey }; setPendingSubmission(request); saveSession(PENDING_ACTION_KEY, request);
    try { const a = await api<Action>("actions", "POST", request); setAction(a); saveSession(LAST_ACTION_KEY, { id: a.id, type: a.type }); setPendingSubmission(null); saveSession(PENDING_ACTION_KEY, null); } catch (e) { const status = (e as { status?: number }).status; if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) { setPendingSubmission(null); saveSession(PENDING_ACTION_KEY, null); } throw e; }
  }
  function context(): Data { return { ...(guildId ? { guildId: guildId.trim() } : {}), ...(channelId ? { channelId: channelId.trim() } : {}), ...(userId ? { userId: userId.trim() } : {}) }; }
  function query(cursor?: string, outcome?: string) { const q = new URLSearchParams({ limit: "100" }); if (guildId) q.set("guildId", guildId.trim()); const start = jstIso(from); const end = jstIso(to); if (start) q.set("from", start); if (end) q.set("to", end); if (start && end && start >= end) throw new Error("終了日時は開始日時より後にしてください"); if (cursor) q.set("cursor", cursor); if (outcome) q.set("outcome", outcome); return q; }
  async function search(cursor?: string, selected: RecordSource = source, outcome?: string) { const version = ++searchVersion.current; const q = cursor && appliedSearch ? new URLSearchParams(appliedSearch) : buildInvestigationQuery({ ...location, outcome: outcome ?? location.outcome }, selected); if (cursor) q.set("cursor", cursor); else setAppliedSearch(q.toString()); const data = await api(`${selected}?${q}`); verifyInvestigationFilters(selected, q, data); if (version !== searchVersion.current) return; setHistory(prev => cursor ? [...prev, ...list(data.items)] : list(data.items)); setNextCursor(data.nextCursor ? String(data.nextCursor) : null); }
  const searchKey = JSON.stringify([source, guildId, channelId, userId, location.messageId, from, to, location.outcome]);
  useEffect(() => {
    if (!["search", "incidents"].includes(tab)) return;
    let cancelled = false; const version = ++searchVersion.current; setSearchLoading(true); setSearchError(""); setHistory([]); setNextCursor(null);
    const timer = setTimeout(async () => { try { const q = buildInvestigationQuery(location); const data = await api(`${source}?${q}`); verifyInvestigationFilters(source, q, data); if (!cancelled && version === searchVersion.current) { setHistory(list(data.items)); setNextCursor(data.nextCursor ? String(data.nextCursor) : null); setAppliedSearch(q.toString()); } } catch (e) { if (!cancelled) setSearchError(e instanceof Error ? e.message : "検索に失敗しました"); } finally { if (!cancelled) setSearchLoading(false); } }, 350);
    return () => { cancelled = true; searchVersion.current++; clearTimeout(timer); };
    // searchKey contains every supported search filter; unrelated navigation cannot restart the request.
  }, [searchKey, tab]);
  useEffect(() => {
    if (!location.selected) { setDetail(null); return; }
    let cancelled = false; setDetailLoading(true); setDetailError("");
    const path = `${location.selectedSource}/${encodeURIComponent(location.selected)}`;
    api(path).then(value => { if (!cancelled) setDetail(value); }).catch(e => { if (!cancelled) setDetailError(e.message); }).finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [location.selected, location.selectedSource]);
  function openRecord(id: string, selectedSource: RecordSource, item?: unknown) { const summary = investigationSummary(item); updateAdminLocation({ section: "investigation", tab: selectedSource === "incidents" ? "incidents" : "search", source: selectedSource, selected: id, selectedSource, ...(tab === "home" ? { guildId: summary.guildId === "未記録" ? "" : summary.guildId, channelId: "", userId: "", messageId: "", from: "", to: "", outcome: "" } : {}) }); }
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
  const selectedOperation = catalog.find(item => item.type === operationType);
  const operationGroups = [...new Set(catalog.map(item => operationGroup(item.type)))];

  return <div className={standalone ? "mx-auto min-h-screen max-w-[1600px] space-y-4 bg-background p-4 md:p-6" : "space-y-4"}>
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><p className="text-muted-foreground">管理API: {health?.ok ? "接続済み" : "接続確認中"} / {date(health?.time)} JST</p><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void refreshConnection()}>接続確認</Button>{safeUrl(health?.independentUrl) ? <a className="rounded border px-3 py-2 text-xs" href={safeUrl(health?.independentUrl)} target="_blank" rel="noreferrer">独立管理Web</a> : null}</div></div>
    {connectionError ? <p role="alert" className="rounded border border-destructive p-3 text-sm">{connectionError} 受付済み操作は履歴から結果を確認できます。</p> : null}
    {catalogError ? <p role="status" className="rounded border p-3 text-sm">{catalogError}</p> : null}
    {connectionError || location.section === "operations" ? <details open={Boolean(connectionError)} className="rounded border p-3"><summary className="cursor-pointer text-sm font-medium">管理デーモンの確認・復旧</summary><div className="mt-3"><AgentRecoveryPanel onRecovered={refreshConnection} /></div></details> : null}
    {action ? <div aria-live="polite" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 p-3"><div><p className="text-sm font-medium">{catalog.find(item => item.type === action.type)?.label || action.type} — {actionStateLabel(action.status)}</p><p className="break-all text-xs text-muted-foreground">受付ID {action.id} / 更新 {date(action.updatedAt || action.createdAt)}</p></div><Button size="sm" variant="outline" onClick={() => setShowAction(value => !value)}>{showAction ? "操作結果を閉じる" : "操作結果を見る"}</Button></div> : null}
    {showAction && action ? <ActionResult action={action} onOpen={id => void perform(() => openAction(id))} /> : null}
    {pendingSubmission ? <div className="rounded border p-3 text-sm"><p>操作の受付結果を確認中です。新しい操作IDでは再実行しません。キー: {pendingSubmission.idempotencyKey}</p><Button variant="outline" disabled={busy} onClick={() => void perform(async () => { const a = await api<Action>("actions", "POST", pendingSubmission); setAction(a); saveSession(LAST_ACTION_KEY, { id: a.id, type: a.type }); setPendingSubmission(null); saveSession(PENDING_ACTION_KEY, null); })}>同じ受付キーで結果を確認</Button></div> : null}
    <div hidden={!active} className="space-y-4">
    {sectionTabs[location.section].length > 1 ? <nav aria-label="作業の種類" className="flex flex-wrap gap-2">{tabs.filter(([key]) => sectionTabs[location.section].includes(key)).map(([key, label]) => <Button variant={tab === key ? "default" : "outline"} aria-pressed={tab === key} key={key} onClick={() => { setTab(key); if (key === "incidents") setSource("incidents"); else if (key === "search" && source === "incidents") setSource("runs"); setError(""); }}>{label}</Button>)}</nav> : null}
    {tab === "home" ? <><ShardMetricsView data={shardData} /><OperationsOverview api={api} onOpen={openRecord} /></> : null}
    {error ? <p role="alert" className="rounded border border-destructive p-3 text-sm">{error}</p> : null}


    {tab === "search" || tab === "incidents" ? <div className={location.selected ? "grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.85fr)]" : ""}><Card className="min-w-0"><CardHeader><CardTitle>{tab === "incidents" ? "障害・診断・通知" : "事象・操作履歴"}</CardTitle><CardDescription>条件を変えると検索結果を更新します。詳細を開いても一覧と検索条件を保持します。</CardDescription></CardHeader><CardContent className="space-y-4"><div className="flex flex-wrap items-end gap-3"><label className="space-y-1 text-sm"><span>記録種別</span><select className={selectClass} value={source} onChange={e => setSource(e.target.value)}><option value="runs">展開の結果</option><option value="events">処理の段階別記録</option><option value="actions">管理操作</option><option value="incidents">障害・診断</option><option value="notifications">通知</option></select></label>{source === "runs" ? <label className="space-y-1 text-sm"><span>処理結果</span><select className={selectClass} value={location.outcome} onChange={e => updateAdminLocation({ outcome: e.target.value, selected: "" })}><option value="">すべて</option><option value="D,P,E,U,X">失敗・一部成功・完了不明</option>{["F", "D", "P", "E", "U", "S", "C", "I", "X"].map(key => <option key={key} value={key}>{resultLabels[key]}</option>)}</select></label> : null}<Button variant="outline" disabled={busy || searchLoading} onClick={() => void perform(() => search())}>再検索</Button></div>
      {appliedSearch && !searchLoading ? <p className="break-all text-xs text-muted-foreground">表示中: {source === "incidents" || source === "notifications" ? "サービス全体" : `サーバー ${new URLSearchParams(appliedSearch).get("guildId") || "すべて"} / チャンネル ${new URLSearchParams(appliedSearch).get("channelId") || "すべて"} / ユーザー ${new URLSearchParams(appliedSearch).get("userId") || "すべて"} / 投稿 ${new URLSearchParams(appliedSearch).get("messageId") || "すべて"}`}</p> : null}
      {searchLoading ? <p role="status" className="py-6 text-sm">記録を検索中…</p> : searchError ? <p role="alert" className="text-sm text-destructive">{searchError}</p> : <InvestigationList items={history} source={source} selected={location.selected} onOpen={openRecord} />}
      {nextCursor ? <Button disabled={busy || searchLoading} variant="outline" onClick={() => void perform(() => search(nextCursor))}>次の100件を追加</Button> : null}
    </CardContent></Card>{location.selected ? <InvestigationDetails value={detail} loading={detailLoading} error={detailError} onClose={() => updateAdminLocation({ selected: "" })} /> : null}</div> : null}

    {tab === "inspect" ? <Card><CardHeader><CardTitle>URL実行検証</CardTitle><CardDescription>実際の取得元から取得し、展開payloadとHTTP応答を保存します。サーバーIDを省略すると既定設定で検証し、設定DBが停止していても調査できます。Discordへ投稿しません。</CardDescription></CardHeader><CardContent className="space-y-4"><Field label="検証するURL" value={url} onChange={setUrl} placeholder="https://..." />{/https?:\/\/(?:www\.)?(?:x|twitter|fxtwitter|vxtwitter)\.com\//i.test(url) ? <div className="flex flex-wrap items-end gap-3"><label className="text-sm">Xの取得元<select className={selectClass} value={sourceId} onChange={e => setSourceId(e.target.value)}><option value="default">稼働中の設定を使用</option><option value="vxtwitter">vxtwitter</option><option value="fxtwitter">fxtwitter</option></select></label><label className="text-sm">別の取得元への切り替え<select className={selectClass} value={sourceFallback} onChange={e => setSourceFallback(e.target.value)}><option value="default">稼働中の設定を使用</option><option value="true">許可する</option><option value="false">許可しない</option></select></label></div> : null}<details className="rounded border p-3"><summary className="cursor-pointer text-sm">設定の上書き・比較条件</summary><div className="grid gap-3 md:grid-cols-2"><label className="text-sm">設定上書き（省略した値はサーバー設定）<Textarea rows={5} className="mt-1 font-mono" value={settingsText} onChange={e => setSettingsText(e.target.value)} /></label><label className="text-sm">同じ保存応答と比較する設定<Textarea rows={5} className="mt-1 font-mono" value={candidateText} onChange={e => setCandidateText(e.target.value)} /></label></div></details><div className="flex flex-wrap gap-2"><Button disabled={!canSubmit()} onClick={() => void perform(() => inspect("url.inspect"))}>実際に取得して展開</Button><Button variant="outline" disabled={!canSubmit() || !baseline} onClick={() => void perform(() => inspect("url.reparse"))}>保存応答を再解析</Button><Button variant="outline" disabled={!canSubmit() || !baseline} onClick={() => void perform(() => inspect("url.compare"))}>同じ応答で設定比較</Button><Button variant="outline" disabled={!baseline} onClick={() => { setSendMode("captured"); setTab("send"); }}>この出力を指定先へ送る</Button></div></CardContent></Card> : null}

    {tab === "send" ? <Card><CardHeader><CardTitle>サーバー・チャンネル指定送信</CardTitle><CardDescription>送信先を照合後、明示的に送信します。URL取得・手入力・検証済み出力に対応し、API応答と各メッセージIDを記録します。</CardDescription></CardHeader><CardContent className="space-y-4"><div className="grid gap-3 md:grid-cols-2"><label className="text-sm">送信内容<select value={sendMode} onChange={e => setSendMode(e.target.value)} className={selectClass}><option value="manual">手入力の本文・Embed・添付</option><option value="url">URLを取得して展開</option><option value="captured">URL検証で確認した出力</option></select></label><Field label="返信先メッセージID（任意）" value={replyTo} onChange={setReplyTo} /></div>
      {sendMode === "manual" ? <><label className="block text-sm">本文<Textarea rows={5} value={content} onChange={e => setContent(e.target.value)} /></label><details className="rounded border p-3"><summary className="cursor-pointer text-sm">Embed・添付・ボタンの詳細編集</summary><label className="mt-3 block text-sm">送信内容（JSON）<Textarea rows={7} className="font-mono" value={payloadText} onChange={e => setPayloadText(e.target.value)} /></label></details><p className="text-xs text-muted-foreground">メンションは既定で通知しません。添付は管理workerが受け付けるHTTPS URLを指定してください。</p></> : sendMode === "url" ? <Field label="展開するURL" value={url} onChange={setUrl} /> : <OutputPreview value={baseline?.steps} />}
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!canSubmit() || !guildId || !channelId} onClick={() => void perform(() => submit("message.resolve", { guildId, channelId, ...(replyTo ? { replyTo } : {}) }))}>サーバー・チャンネルを照合</Button><Button disabled={!canSubmit() || !resolved} onClick={() => void perform(send)}>確認した送信先へ送信</Button></div>{resolved ? <div className="space-y-3 rounded border p-3">
        <p className="font-medium">送信先: {text(obj(resolved.guild).name)} / #{text(obj(resolved.channel).name)}</p>
        <p className="break-all text-sm">サーバーID: {text(obj(resolved.guild).id)} / チャンネルID: {text(obj(resolved.channel).id)}</p>
        <p className="text-xs text-muted-foreground">Discord APIで宛先へのアクセスを照合済み。個別の送信権限は未評価です。実際の送信応答で成功・拒否・成否不明を記録します。</p>
        <RawEvidence value={resolved} label="照合結果・権限情報の全項目" />
      </div> : null}</CardContent></Card> : null}

    {tab === "settings" ? <Card><CardHeader><CardTitle>サーバーの設定</CardTitle><CardDescription>現在値と変更後の値を比較して保存します。ほかの管理者による変更があれば再取得してから適用します。</CardDescription></CardHeader><CardContent className="space-y-4"><div className="flex flex-wrap items-end gap-3"><label className="text-sm"><span className="mb-1 block">サービス</span>{providerCatalog.length ? <select className={selectClass} value={provider} onChange={e => setProvider(e.target.value)}>{providerCatalog.map(item => <option key={text(item.providerId)} value={text(item.providerId)}>{text(item.label)}</option>)}</select> : <Input value={provider} onChange={e => setProvider(e.target.value)} />}</label><Button disabled={!canSubmit() || !guildId} onClick={() => void perform(() => submit("settings.get", { guildId, providerId: provider }))}>現在の設定を取得</Button></div>
      {!guildId ? <p className="text-sm text-muted-foreground">上の欄で対象サーバーを選択してください。</p> : null}
      <SettingValueEditor snapshot={settingResult} settingKey={settingKey} value={settingValue} onKey={key => { setSettingKey(key); setResettingSetting(false); }} onValue={value => { setSettingValue(value); setResettingSetting(false); }} />
      {settingResult && settingKey ? <><div className="grid gap-3 rounded-lg bg-muted p-3 sm:grid-cols-2"><div><p className="text-sm font-medium">現在の値</p><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{pretty(obj(settingResult.settings)[settingKey])}</pre></div><div><p className="text-sm font-medium">変更後の値</p><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{settingValue}</pre></div></div><label className="flex gap-2 text-sm"><input type="checkbox" checked={settingConfirmation} onChange={e => setSettingConfirmation(e.target.checked)} />対象サーバーと変更内容を確認しました</label><div className="flex flex-wrap gap-2"><Button disabled={!canSubmit() || !settingConfirmation} onClick={() => void perform(() => submit(resettingSetting ? "settings.reset" : "settings.change", { guildId, providerId: provider, key: settingKey, ...(resettingSetting ? {} : { value: JSON.parse(settingValue) }), expectedHash: settingResult?.settingsHash ?? settingResult?.hash }))}>変更を保存</Button><Button variant="outline" disabled={!canSubmit()} onClick={() => { setSettingValue(pretty(obj(settingResult.defaults)[settingKey])); setResettingSetting(true); setSettingConfirmation(false); }}>既定値を変更案にする</Button></div></> : null}
      <details className="rounded border p-3"><summary className="cursor-pointer text-sm">別サーバーの設定をコピー</summary><div className="mt-3 flex flex-wrap items-end gap-3"><Field label="コピー元サーバーID" value={sourceGuild} onChange={setSourceGuild} /><label className="flex gap-2 text-sm"><input type="checkbox" checked={copyConfirmed} onChange={e => setCopyConfirmed(e.target.checked)} />現在のサーバー設定をコピー元の設定で置き換えることを確認しました</label><Button variant="outline" disabled={!canSubmit() || !settingResult || !sourceGuild || !copyConfirmed} onClick={() => void perform(() => submit("settings.copy", { guildId, sourceGuildId: sourceGuild, providerId: provider, expectedHash: settingResult?.settingsHash ?? settingResult?.hash }))}>設定をコピー</Button></div></details>
      {settingResult ? <RawEvidence value={settingResult} label="設定の原記録・適用状況" /> : null}<Button variant="outline" size="sm" onClick={() => updateAdminLocation({ section: "investigation", tab: "search", source: "actions", selected: "", channelId: "", userId: "", messageId: "" })}>このサーバーの操作履歴</Button>
    </CardContent></Card> : null}

    {tab === "operations" ? <Card><CardHeader><CardTitle>管理操作</CardTitle><CardDescription>必要な値は画面の項目から入力します。JSONやコマンドを直接入力する必要はありません。実行後は受付IDと履歴を画面上で確認できます。</CardDescription></CardHeader><CardContent className="space-y-4"><label className="block space-y-1 text-sm"><span>実行する操作</span><select aria-label="管理操作" className={selectClass} value={operationType} onChange={e => { const type = e.target.value; const selected = catalog.find(item => item.type === type); setOperationType(type); setOperationInput({ ...obj(selected?.inputExample), ...context() }); setOperationConfirmed(false); }}><option value="">操作を選択</option>{operationGroups.map(group => <optgroup key={group} label={group}>{catalog.filter(item => operationGroup(item.type) === group).map(item => <option value={item.type} key={item.type} disabled={item.available === false}>{item.label || item.type} {item.mutating ? "（変更操作）" : ""}{item.available === false ? "（この環境では利用不可）" : ""}</option>)}</optgroup>)}</select></label>{selectedOperation ? <div className="space-y-4 rounded border p-4"><div><h3 className="font-medium">{selectedOperation.label || selectedOperation.type}</h3><p className="mt-1 text-sm text-muted-foreground">{selectedOperation.description || "操作の説明は管理デーモンから取得できませんでした。"}</p>{selectedOperation.available === false ? <p role="alert" className="mt-2 text-sm text-destructive">この環境では実行できません。{selectedOperation.unavailableReason || "利用条件を確認してください。"}</p> : null}</div><OperationInputForm action={selectedOperation} input={operationInput} onChange={next => { setOperationInput(next); setOperationConfirmed(false); }} disabled={busy || Boolean(pendingSubmission) || selectedOperation.available === false} />{selectedOperation.mutating ? <label className="flex gap-2 rounded border border-amber-500/50 bg-amber-500/10 p-3 text-sm"><input type="checkbox" checked={operationConfirmed} disabled={busy || Boolean(pendingSubmission) || selectedOperation.available === false} onChange={event => setOperationConfirmed(event.target.checked)} /><span>対象・入力内容・影響を確認し、この管理操作を実行することを確認しました。受付後は同じ受付IDで結果を確認し、同じ操作を重複して実行しません。</span></label> : <p className="text-xs text-muted-foreground">参照操作です。変更は行いませんが、取得結果は操作履歴に記録されます。</p>}<Button disabled={!canSubmit() || !selectedOperation || selectedOperation.available === false || (selectedOperation.mutating && !operationConfirmed)} onClick={() => void perform(() => submit(selectedOperation.type, operationInput))}>{selectedOperation.mutating ? "内容を確認して操作を実行" : "操作を実行"}</Button></div> : <p className="rounded border bg-muted/20 p-3 text-sm text-muted-foreground">カテゴリから操作を選ぶと、必要な入力欄と実行ボタンを表示します。</p>}<RawEvidence value={catalog} label="管理デーモンが提供する操作の原記録" /></CardContent></Card> : null}

    {tab === "metrics" ? <Card><CardHeader><CardTitle>要求単位の稼働・影響</CardTitle><CardDescription>根要求を一件として集計。閲覧・既読・リンククリックはDiscord APIから取得できず、統計へ含めません。分母・対象期間・観測状態を併記します。</CardDescription></CardHeader><CardContent className="space-y-4"><div className="flex flex-wrap items-end gap-3"><Button disabled={busy} onClick={() => void perform(async () => { const [metrics, shards] = await Promise.allSettled([api(`metrics?${query()}`), api("shards")]); if (metrics.status === "rejected") throw metrics.reason; setMetricData(metrics.value); if (shards.status === "fulfilled") setShardData(shards.value); else setError(`シャード状態の取得に失敗しました: ${text(shards.reason instanceof Error ? shards.reason.message : shards.reason)}`); })}>集計する</Button><Button type="button" variant="outline" disabled={busy} onClick={() => void perform(async () => setShardData(await api("shards")))}>シャード状態を更新</Button></div>{metricData ? <MetricsView data={metricData} onDrill={outcome => updateAdminLocation({ section: "investigation", tab: "search", source: "runs", outcome: outcome || "", selected: "", channelId: "", userId: "", messageId: "" })} /> : <p className="text-sm">サーバーと期間を指定して集計してください。過去の旧イベントを要求数へ推定変換しません。</p>}<ShardMetricsView data={shardData || (metricData ? obj(metricData.shards) : null)} /></CardContent></Card> : null}

    {tab === "recovery" ? <EmergencyRecoveryPanel /> : null}
    {tab === "policies" ? <Card><CardHeader><CardTitle>監視・自動修復ポリシー</CardTitle><CardDescription>LLMを使わず診断ルールと証拠で判定します。適用済みの版を指定して更新し、競合を防ぎます。</CardDescription></CardHeader><CardContent className="space-y-4"><Button variant="outline" disabled={busy} onClick={() => void perform(async () => { const p = await api("policies"); setPolicies(p); setPolicyText(pretty(p)); })}>現在のポリシーを取得</Button>{policies ? <OperationValueEditor name="policy" value={parseObject(policyText, "ポリシー")} onChange={value => setPolicyText(pretty(value))} disabled={busy} /> : null}<Button disabled={busy || !policies} onClick={() => void perform(async () => { const p = await api("policies", "PUT", { ...parseObject(policyText, "ポリシー"), expectedRevision: policies?.revision }); setPolicies(p); setPolicyText(pretty(p)); })}>ポリシーを更新</Button>{policies ? <RawEvidence value={policies} label="適用されたポリシー" /> : null}</CardContent></Card> : null}

    {tab === "policies" ? <Card><CardHeader><CardTitle>独立管理Webのログイン</CardTitle><CardDescription>通常ダッシュボードやDiscord OAuthが停止した場合に使う管理者パスワードを設定します。管理デーモンの接続トークンをブラウザーへ渡しません。</CardDescription></CardHeader><CardContent className="space-y-3"><div className="grid gap-3 md:grid-cols-2"><Field label="新しい管理者パスワード" type="password" value={password} onChange={setPassword} /><Field label="新しいパスワード（再入力）" type="password" value={passwordAgain} onChange={setPasswordAgain} /></div><Button disabled={busy || !password || password !== passwordAgain} onClick={() => void perform(async () => { await api("account/password", "POST", { password }); setPassword(""); setPasswordAgain(""); setAccountMessage("独立管理Webのパスワードを更新しました。"); })}>パスワードを設定</Button>{accountMessage ? <p role="status" className="text-sm">{accountMessage}</p> : null}</CardContent></Card> : null}
    </div>
  </div>;
}

export function MetricsView({ data, onDrill }: { data: Data; onDrill: (outcome?: string) => void }) {
  const outcomes = obj(data.outcomes); const labels = obj(data.outcomeLabels); const success = obj(data.fullSuccess); const coverage = obj(data.coverage);
  const unmeasured = coverage.measurementState === "not_measured" || (!coverage.measurementState && coverage.state === "no_root_request_records");
  const cards: { label: string; value: string; note: string; outcome?: string }[] = [
    { label: "展開要求数", value: text(data.requestCount), note: "根要求IDで重複排除。引用・再試行は加算しません。" },
    { label: "完全成功を確認できた割合", value: success.ratio == null ? "対象なし" : `${(Number(success.ratio) * 100).toFixed(2)}%`, note: `${text(success.numerator)} / ${text(success.denominator)} 要求（F / F+D+P+E+U+X）`, outcome: "F" },
    { label: "問題のある要求", value: text(data.problemRequestCount), note: "代替・部分成功・失敗・対象制約・結果不明", outcome: "D,P,E,U,X" },
    { label: "設定による見送り", value: text(data.skippedRequestCount), note: "完全成功率の分母から分離", outcome: "S" },
    { label: "影響サーバー数", value: text(data.affectedGuildCount), note: `問題のある要求のサーバー集合。サーバー不明の要求: ${text(data.affectedUnknownGuildRequests)}`, outcome: "D,P,E,U,X" },
    { label: "未完了の最長経過時間", value: data.oldestUnfinishedAgeMs == null ? "対象なし" : `${(Number(data.oldestUnfinishedAgeMs) / 1000).toFixed(1)}秒`, note: "完了時間の分布には混ぜません", outcome: "I,X" },
  ];
  return <div className="space-y-4"><p className="text-xs text-muted-foreground">{date(data.from)} ～ {date(data.to)} JST（終了を含まない） / 定義 {text(data.definitionVersion)} / 集計時点 {date(data.snapshotAt)}</p><div className="grid gap-3 md:grid-cols-3">{cards.map(card => <button key={card.label} className="rounded border bg-card p-4 text-left" disabled={unmeasured} onClick={() => onDrill(card.outcome)}><span className="text-sm">{card.label}</span><p className="my-2 text-2xl font-semibold">{unmeasured ? "未計測" : card.value}</p><p className="text-xs text-muted-foreground">{unmeasured ? "本番の要求を観測できたことを確認できません。" : card.note}</p></button>)}</div>
    <div className="rounded border p-3"><p className="font-medium">要求結果の内訳</p><div className="mt-2 flex flex-wrap gap-2">{unmeasured ? <p className="text-sm">未計測。本番の要求記録または収集状態を確認できていません。</p> : Object.entries(outcomes).map(([key, value]) => <Button key={key} variant="outline" onClick={() => onDrill(key)}>{text(labels[key] ?? key)}: {text(value)}</Button>)}</div></div>
    <div className="grid gap-3 lg:grid-cols-2"><div className="rounded border p-3"><h3 className="mb-2 font-medium">完了時間（結果別）</h3>{unmeasured ? <p className="text-sm">未計測</p> : Object.entries(obj(data.latencyByOutcome)).map(([key, value]) => { const row = obj(value); return <p className="mb-2 text-sm" key={key}>{text(labels[key] ?? key)} / {text(row.sampleCount)}件 / P50 {row.p50Ms == null ? "未取得" : `${(Number(row.p50Ms) / 1000).toFixed(3)}秒`} / P95 {row.p95Ms == null ? "未取得" : `${(Number(row.p95Ms) / 1000).toFixed(3)}秒`}</p>; })}<p className="text-xs text-muted-foreground">保存された完了記録のnearest-rank分位点。未計測と、観測済みで対象0件の状態を区別します。</p></div><div className="rounded border p-3"><h3 className="mb-2 font-medium">計測状態</h3><p className="text-sm">状態: {unmeasured ? "未計測" : "保存された観測結果"} / 収集: {text(coverage.collectionState)} / 最終heartbeat: {date(coverage.lastHeartbeatAt)} / 最初の要求記録: {date(coverage.firstRecordedRequestAt)} / 最新: {date(coverage.latestRecordedRequestAt)}</p><p className="mt-2 text-xs text-muted-foreground">旧記録からの要求結果の復元は行いません。記録されていない期間を成功や0件として判断しないでください。</p><RawEvidence value={{ coverage, excluded: data.excluded }} label="記録状態と診断・管理操作の除外件数" /></div></div>
    <div className="rounded border p-3"><h3 className="mb-2 font-medium">サービス別の結果</h3>{unmeasured ? <p className="text-sm">未計測</p> : Object.entries(obj(data.byProvider)).map(([provider, value]) => <p className="mb-2 text-sm" key={provider}>{provider}: {Object.entries(obj(value)).map(([outcome, count]) => `${text(labels[outcome] ?? outcome)} ${text(count)}`).join(" / ")}</p>)}</div>
    <Button variant="outline" disabled={unmeasured} onClick={() => onDrill()}>この条件の根要求と結果を開く</Button><RawEvidence value={data} label="指標辞書・分子分母・計測状態（全項目）" />
  </div>;
}

type InputValueKind = "string" | "number" | "boolean" | "object" | "array" | "null";
type OperationFieldMeta = { label: string; hint?: string; placeholder?: string; multiline?: boolean; inputType?: "text" | "url"; options?: { value: string; label: string }[] };

const operationFields: Record<string, OperationFieldMeta> = {
  guildId: { label: "サーバーID", placeholder: "例: 123456789012345678" },
  sourceGuildId: { label: "コピー元サーバーID", placeholder: "例: 123456789012345678" },
  channelId: { label: "チャンネルID", placeholder: "例: 123456789012345678" },
  userId: { label: "対象ユーザーID", placeholder: "例: 123456789012345678" },
  targetId: { label: "委任先のID", placeholder: "ユーザーまたはロールのID" },
  targetType: { label: "委任先の種類", options: [{ value: "user", label: "ユーザー" }, { value: "role", label: "ロール" }] },
  accessLevel: { label: "委任する権限", options: [{ value: "view", label: "閲覧" }, { value: "edit", label: "変更" }] },
  providerId: { label: "プロバイダーID", placeholder: "例: twitter" },
  sourceId: { label: "取得元ID", placeholder: "登録済みの取得元ID" },
  ttlSeconds: { label: "一時切り替えの有効時間（秒）", hint: "期限を過ぎると通常の取得元に戻ります。" },
  expectedRevision: { label: "確認した設定リビジョン" },
  expectedHash: { label: "確認した設定ハッシュ", hint: "現在値の取得結果に含まれる値を使用します。" },
  expectedInvocationId: { label: "確認した起動ID", hint: "先に状態確認を行い、その結果の起動IDを指定します。" },
  expectedEpoch: { label: "確認した復旧世代（epoch）" },
  expectedCandidateId: { label: "確認した復旧候補ID" },
  expectedBackupId: { label: "確認したバックアップID" },
  expectedBackupSha256: { label: "確認したバックアップのSHA-256" },
  expectedBackupTimestamp: { label: "確認したバックアップ時刻" },
  expectedPrimaryIntentRevision: { label: "確認した本番系の指示リビジョン" },
  expectedPrimaryIntentState: { label: "確認した本番系の指示状態", options: [{ value: "running", label: "稼働指示" }, { value: "stopped", label: "停止指示" }, { value: "maintenance", label: "保守指示" }, { value: "unknown", label: "未確認" }] },
  expectedOciPolicyRevision: { label: "確認した予備側ポリシーリビジョン" },
  targetNode: { label: "切り替え先", options: [{ value: "oci", label: "予備のクラウドサーバー" }, { value: "primary", label: "メインサーバー" }] },
  executeAt: { label: "実行日時", hint: "専用の「緊急復旧」タブではJSTの日時選択と状態の自動入力を利用できます。" },
  operationId: { label: "予約・操作ID" },
  queryId: { label: "管理SQLのID" },
  onlyIfOverdue: { label: "期限超過の場合だけ中止する" },
  includeCompleted: { label: "完了済みのSQLも表示する" },
  lines: { label: "取得する行数" },
  minutes: { label: "遡る時間（分）" },
  source: { label: "ログの取得元", hint: "管理デーモンが提供する取得元IDを指定します。" },
  kind: { label: "レポート種別" },
  text: { label: "翻訳する本文", multiline: true },
  target: { label: "翻訳先の言語コード", placeholder: "例: ja" },
  url: { label: "対象URL", inputType: "url", placeholder: "https://..." },
  username: { label: "アカウント名", placeholder: "@を除いた名前" },
  webhookUrl: { label: "送信先Webhook URL", inputType: "url", placeholder: "https://discord.com/api/webhooks/..." },
  enabled: { label: "有効にする" },
  id: { label: "登録ID" },
  candidateId: { label: "確認した復旧候補ID" },
  backupId: { label: "確認したバックアップID" },
  backupSha256: { label: "確認したバックアップのSHA-256" },
  sourceTimestamp: { label: "確認したバックアップ時刻" },
  tweetId: { label: "投稿ID" },
  messageId: { label: "Bot投稿のメッセージID" },
  reason: { label: "操作理由", multiline: true, hint: "操作履歴に保存されます。対象と理由が分かる内容を入力してください。" },
  confirm: { label: "切り替えを実行することを確認した" },
  acceptDataRisk: { label: "データ同期時点によって履歴が戻る可能性を確認した" },
  acceptPrimaryIntentOverride: { label: "既存の停止・保守指示との競合可能性を確認した" },
  acceptBackupRollback: { label: "バックアップ以後の変更が失われる可能性を確認した" },
  acceptMissingSavedata: { label: "savedataが移行対象外であることを確認した" },
};

const inputValueKind = (value: unknown): InputValueKind => value === null || value === undefined ? "null" : Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string";
const blankInputValue = (kind: InputValueKind): unknown => ({ string: "", number: 0, boolean: false, object: {}, array: [], null: null } as const)[kind];
const safeOperationKey = (value: string) => /^[A-Za-z][A-Za-z0-9_.-]*$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
const operationFieldLabel = (name: string) => operationFields[name]?.label || name;
const operationFieldHint = (name: string) => operationFields[name]?.hint;

function InputKindSelector({ value, onChange, disabled, label = "値の種類" }: { value: InputValueKind; onChange: (value: InputValueKind) => void; disabled?: boolean; label?: string }) {
  return <label className="block space-y-1 text-sm"><span>{label}</span><select className={selectClass} value={value} disabled={disabled} onChange={event => onChange(event.target.value as InputValueKind)}><option value="string">文字列</option><option value="number">数値</option><option value="boolean">真偽値</option><option value="object">項目の組み合わせ</option><option value="array">一覧</option><option value="null">未指定（null）</option></select></label>;
}

function OperationArrayEditor({ name, value, onChange, disabled, depth }: { name: string; value: unknown[]; onChange: (value: unknown[]) => void; disabled?: boolean; depth: number }) {
  const [additionKind, setAdditionKind] = useState<InputValueKind>("string");
  const [additionText, setAdditionText] = useState("");
  const add = () => {
    let next = blankInputValue(additionKind);
    if (additionKind === "string") next = additionText;
    if (additionKind === "number") { const number = Number(additionText); if (!Number.isFinite(number)) return; next = number; }
    onChange([...value, next]);
    setAdditionText("");
  };
  return <fieldset className="space-y-3 rounded border p-3"><legend className="px-1 text-sm font-medium">{operationFieldLabel(name)}（一覧）</legend>{value.length ? value.map((item, index) => <div key={index} className="flex gap-2 rounded border bg-muted/20 p-2"><div className="min-w-0 flex-1"><OperationValueEditor name={`${operationFieldLabel(name)} ${index + 1}`} value={item} onChange={next => onChange(value.map((entry, itemIndex) => itemIndex === index ? next : entry))} disabled={disabled} depth={depth + 1} /></div><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}>削除</Button></div>) : <p className="text-sm text-muted-foreground">項目はありません。</p>}<div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"><InputKindSelector value={additionKind} onChange={setAdditionKind} disabled={disabled} label="追加する値の種類" />{additionKind === "string" || additionKind === "number" ? <Field label="値" type={additionKind === "number" ? "number" : "text"} value={additionText} onChange={setAdditionText} /> : <p className="self-end text-xs text-muted-foreground">追加後に画面上で項目を編集します。</p>}<Button type="button" className="self-end" variant="outline" disabled={disabled || (additionKind === "number" && additionText !== "" && !Number.isFinite(Number(additionText)))} onClick={add}>項目を追加</Button></div></fieldset>;
}

function OperationObjectEditor({ value, template, onChange, disabled, depth }: { value: Data; template?: Data; onChange: (value: Data) => void; disabled?: boolean; depth: number }) {
  const [newKey, setNewKey] = useState("");
  const [newKind, setNewKind] = useState<InputValueKind>("string");
  const defaults = template || {};
  const keys = [...new Set([...Object.keys(defaults), ...Object.keys(value)])].filter(safeOperationKey);
  const add = () => {
    const key = newKey.trim();
    if (!safeOperationKey(key) || Object.prototype.hasOwnProperty.call(value, key)) return;
    onChange({ ...value, [key]: blankInputValue(newKind) });
    setNewKey("");
  };
  return <div className="space-y-3">{keys.map(key => {
    const current = Object.prototype.hasOwnProperty.call(value, key) ? value[key] : defaults[key];
    const fromTemplate = Object.prototype.hasOwnProperty.call(defaults, key);
    return <div className="flex gap-2 rounded border bg-muted/20 p-2" key={key}><div className="min-w-0 flex-1"><OperationValueEditor name={key} value={current} template={defaults[key]} onChange={next => onChange({ ...value, [key]: next })} disabled={disabled} depth={depth + 1} /></div>{!fromTemplate ? <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { const next = { ...value }; delete next[key]; onChange(next); }}>項目を削除</Button> : null}</div>;
  })}<div className="grid gap-2 rounded border border-dashed p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"><Field label="追加する項目名" value={newKey} onChange={setNewKey} placeholder="例: providerId" /><InputKindSelector value={newKind} onChange={setNewKind} disabled={disabled} label="追加する項目の種類" /><Button type="button" className="self-end" variant="outline" disabled={disabled || !safeOperationKey(newKey.trim()) || Object.prototype.hasOwnProperty.call(value, newKey.trim())} onClick={add}>項目を追加</Button></div><p className="text-xs text-muted-foreground">追加する項目名は英数字・`.`・`_`・`-`のみ使用できます。必要なときだけ追加し、APIの仕様にない項目は送信しないでください。</p></div>;
}

function OperationValueEditor({ name, value, template, onChange, disabled, depth = 0 }: { name: string; value: unknown; template?: unknown; onChange: (value: unknown) => void; disabled?: boolean; depth?: number }) {
  const kind = inputValueKind(value);
  const meta = operationFields[name];
  const label = operationFieldLabel(name);
  const hint = operationFieldHint(name);
  if (kind === "boolean") return <label className="flex gap-2 text-sm"><input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span>{label}</span>{hint ? <span className="text-muted-foreground">{hint}</span> : null}</label>;
  if (kind === "number") return <label className="block space-y-1 text-sm"><span>{label}</span><Input type="number" value={String(value)} disabled={disabled} onChange={event => { const next = Number(event.target.value); onChange(event.target.value === "" ? 0 : Number.isFinite(next) ? next : value); }} />{hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}</label>;
  if (kind === "object") return <fieldset className="space-y-2 rounded border p-3"><legend className="px-1 text-sm font-medium">{label}</legend>{hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}<OperationObjectEditor value={obj(value)} template={obj(template)} onChange={onChange} disabled={disabled} depth={depth} /></fieldset>;
  if (kind === "array") return <OperationArrayEditor name={name} value={list(value)} onChange={onChange} disabled={disabled} depth={depth} />;
  if (kind === "null") return <div className="space-y-1"><InputKindSelector value="null" onChange={next => onChange(blankInputValue(next))} disabled={disabled} label={label} />{hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}</div>;
  if (meta?.options) return <label className="block space-y-1 text-sm"><span>{label}</span><select className={selectClass} value={String(value)} disabled={disabled} onChange={event => onChange(event.target.value)}>{meta.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}</label>;
  if (meta?.multiline) return <label className="block space-y-1 text-sm"><span>{label}</span><Textarea rows={4} value={String(value)} placeholder={meta.placeholder} disabled={disabled} onChange={event => onChange(event.target.value)} />{hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}</label>;
  return <label className="block space-y-1 text-sm"><span>{label}</span><Input type={meta?.inputType || "text"} value={String(value)} placeholder={meta?.placeholder} disabled={disabled} onChange={event => onChange(event.target.value)} />{hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}</label>;
}

function OperationInputForm({ action, input, onChange, disabled }: { action: CatalogAction; input: Data; onChange: (input: Data) => void; disabled?: boolean }) {
  const template = obj(action.inputExample);
  const keys = [...new Set([...Object.keys(template), ...Object.keys(input)])].filter(safeOperationKey);
  if (!keys.length) return <p className="rounded border bg-muted/20 p-3 text-sm text-muted-foreground">この操作には追加の入力はありません。</p>;
  return <OperationObjectEditor key={action.type} value={input} template={template} onChange={onChange} disabled={disabled} depth={0} />;
}

function operationGroup(type: string) {
  if (type.startsWith("recovery.")) return "復旧・切り替え";
  if (type.startsWith("service.") || type.startsWith("agent.") || type.startsWith("analysis.") || type.startsWith("database.")) return "サービス管理";
  if (type.startsWith("diagnostics.") || type.startsWith("logs.") || type === "kernel.logs") return "診断・ログ";
  if (type.startsWith("settings.") || type.startsWith("provider.") || type.startsWith("access.")) return "設定・アクセス";
  if (type.startsWith("autoextract.") || type.startsWith("saved.")) return "自動展開・保存データ";
  if (type.startsWith("url.") || type.startsWith("message.") || type === "text.translate") return "URL・送信・翻訳";
  return "その他";
}

export function ShardMetricsView({ data }: { data: Data | null }) {
  if (!data) return <div className="rounded border p-3 text-sm text-muted-foreground">シャード状態を読み込み中です。</div>;
  const summary = obj(data);
  const items = Array.isArray(summary.items) ? summary.items.map(obj) : [];
  const rows = items.map((row) => ({
    シャード: row.shardId,
    接続: row.availability === "online" ? "オンライン" : row.availability === "offline" ? "オフライン" : "未観測",
    状態: row.status,
    Ping: row.pingMs == null ? "未取得" : `${row.pingMs} ms`,
    "直近1分の完了": row.completedLastMinute == null ? "未計測" : metricCount(row.completedLastMinute),
    "本日の完了": row.completedToday == null ? "未計測" : metricCount(row.completedToday),
    "直近1分の受付": row.startedLastMinute == null ? "未計測" : metricCount(row.startedLastMinute),
    "本日の受付": row.startedToday == null ? "未計測" : metricCount(row.startedToday),
  }));
  return <div className="rounded border p-3"><div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-medium">シャード別の接続・処理数</h3><span className="text-xs text-muted-foreground">{text(summary.state)} / heartbeat {date(summary.heartbeatAt)}</span></div><p className="mt-1 text-xs text-muted-foreground">オンライン判定は最新heartbeat（45秒以内）のdiscord.js状態、処理数は保存されたrequestイベントの完了件数です。直近1分はローリング、本日はJSTの日付境界です。</p>{rows.length ? <MetricsTable rows={rows} /> : <p className="mt-3 text-sm text-muted-foreground">シャード状態はまだ観測できません。Bot heartbeatが保存されるまでオフラインとは判定しません。</p>}<div className="mt-3 grid gap-2 text-sm sm:grid-cols-2"><div className="rounded bg-muted p-2">全体（直近1分の完了）: {metricCount(summary.processingLastMinute)}</div><div className="rounded bg-muted p-2">全体（本日の完了）: {metricCount(summary.processingToday)}</div></div><RawEvidence value={summary} label="シャード状態・処理数の原記録" /></div>;
}

function metricCount(value: unknown) {
  if (value === null || value === undefined || value === "") return "未取得";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString("ja-JP") : String(value);
}

function MetricsTable({ rows }: { rows: Data[] }) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return <div className="overflow-auto rounded-md border"><table className="min-w-full border-collapse text-left text-xs"><thead className="bg-muted text-muted-foreground"><tr>{columns.map((column) => <th key={column} className="whitespace-normal break-words px-3 py-2 font-medium">{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={String(row["シャード"] || index)} className="border-t">{columns.map((column) => <td key={column} className="min-w-24 whitespace-normal break-words px-3 py-2" title={text(row[column])}>{text(row[column])}</td>)}</tr>)}</tbody></table></div>;
}
