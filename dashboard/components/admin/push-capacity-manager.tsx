"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { NotificationPlanPolicy } from "./notification-plan-manager";
import { PushCapacityDiagnostics } from "./push-capacity-diagnostics";

type CapacityAPI = (path: string, method?: string, body?: unknown) => Promise<unknown>;
type GlobalPolicy = { kind: "global"; freePoolLimit: number; supporterPoolLimit: number; updatedAtMs: number };
type PaidPolicy = { kind: "paid"; planId: string; label: string; planEnabled: boolean; eligible: boolean; specialSlotLimit: number; realtimeEnabled: boolean | null; updatedAtMs: number };
type Policy = GlobalPolicy | PaidPolicy;
type Draft = { freePoolLimit: string; supporterPoolLimit: string; specialSlotLimit: string; eligible: boolean; realtimeEnabled: boolean };
const isCapacity = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 100000;
const validNumber = (value: string) => /^\d+$/u.test(value) && isCapacity(Number(value));
const isReserved = (id: string) => ["free", "supporter"].includes(id.toLowerCase());

function parsePolicy(value: unknown, kind: Policy["kind"], planId?: string): Policy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid capacity response");
  const item = value as Record<string, unknown>;
  if (item.featureEnabled !== false || !Number.isSafeInteger(item.updatedAtMs) || Number(item.updatedAtMs) < 0) throw new Error("Invalid capacity response");
  if (kind === "global" && isCapacity(item.freePoolLimit) && isCapacity(item.supporterPoolLimit)) {
    return { kind, freePoolLimit: item.freePoolLimit, supporterPoolLimit: item.supporterPoolLimit, updatedAtMs: Number(item.updatedAtMs) };
  }
  if (kind === "paid" && item.planId === planId && typeof planId === "string" && !isReserved(planId)
    && item.isPaid === true && item.consumesUserSlots === true && typeof item.label === "string"
    && typeof item.planEnabled === "boolean" && typeof item.eligible === "boolean" && isCapacity(item.specialSlotLimit)
    && (item.realtimeEnabled === undefined || typeof item.realtimeEnabled === "boolean")) {
    return { kind, planId, label: item.label, planEnabled: item.planEnabled, eligible: item.eligible,
      specialSlotLimit: item.specialSlotLimit, realtimeEnabled: typeof item.realtimeEnabled === "boolean" ? item.realtimeEnabled : null, updatedAtMs: Number(item.updatedAtMs) };
  }
  throw new Error("Invalid capacity response");
}
function draftOf(policy: Policy): Draft {
  return policy.kind === "global"
    ? { freePoolLimit: String(policy.freePoolLimit), supporterPoolLimit: String(policy.supporterPoolLimit), specialSlotLimit: "", eligible: false, realtimeEnabled: false }
    : { freePoolLimit: "", supporterPoolLimit: "", specialSlotLimit: String(policy.specialSlotLimit), eligible: policy.eligible, realtimeEnabled: policy.realtimeEnabled === true };
}
function feedback(cause: unknown, loading = false): string {
  const error = cause && typeof cause === "object" ? cause as { status?: number; code?: string; retryAfterMs?: number } : {};
  if (error.status === 409 || error.code === "AUTOMATION_PUSH_CAPACITY_CONFLICT") return "ほかの管理者による変更があります。最新の設定を再取得し、保持した入力内容と比較してください。";
  if (error.status === 403) return "容量の設定には管理者権限が必要です。入力内容は保持されています。";
  if (error.status === 404) return "対象の設定を確認できません。通知プランの一覧を更新してください。入力内容は保持されています。";
  if (error.status === 422) return "入力した枠数と対象プランを確認してください。入力内容は保持されています。";
  if (error.status === 429) {
    const seconds = Math.ceil(Math.min(86400000, Math.max(1000, Number(error.retryAfterMs) || 1000)) / 1000);
    return `操作が集中しています。約${seconds}秒待ってから再試行してください。入力内容は保持されています。`;
  }
  return loading ? "容量の設定を読み込めませんでした。入力内容を保持して再試行できます。" : "容量の設定を保存できませんでした。入力内容を保持して再試行できます。";
}

function CapacityEditor({ api, plan, onSaved }: { api: CapacityAPI; plan?: NotificationPlanPolicy; onSaved?: () => void }) {
  const kind = plan ? "paid" : "global", path = plan ? `push-capacity/plans/${encodeURIComponent(plan.planId)}` : "push-capacity";
  const [baseline, setBaseline] = useState<Policy | null>(null), [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [loadFailed, setLoadFailed] = useState(false), [conflict, setConflict] = useState(false), [status, setStatus] = useState("");
  const [reviewedVersion, setReviewedVersion] = useState<number | null>(null);
  const alive = useRef(false), request = useRef(0), action = useRef(false);
  const title = plan ? `${plan.label}の特殊枠` : "全利用者の共有枠";
  const reloadLabel = plan ? "最新の特殊枠を再取得" : "最新の共有枠を再取得";

  const load = useCallback(async (manual = false) => {
    const version = ++request.current;
    setLoading(true); setError("");
    try {
      const next = parsePolicy(await api(path), kind, plan?.planId);
      if (!alive.current || request.current !== version) return;
      setBaseline(next); setDraft(previous => previous ?? draftOf(next)); setLoadFailed(false); setConflict(false); setReviewedVersion(null);
      if (manual) setStatus("最新の設定を再取得しました。入力内容を保持しています。変更内容をもう一度確認してください。");
    } catch (cause) {
      if (alive.current && request.current === version) { setLoadFailed(true); setError(feedback(cause, true)); }
    } finally { if (alive.current && request.current === version) setLoading(false); }
  }, [api, path, kind, plan?.planId]);
  useEffect(() => {
    alive.current = true; void load();
    return () => { alive.current = false; request.current++; };
  }, [load, plan?.updatedAtMs]);

  const valid = Boolean(baseline && draft && (baseline.kind === "global"
    ? validNumber(draft.freePoolLimit) && validNumber(draft.supporterPoolLimit)
    : validNumber(draft.specialSlotLimit) && (!draft.eligible || baseline.planEnabled)
      && (!draft.realtimeEnabled || baseline.planEnabled || baseline.realtimeEnabled === true)));
  const changed = Boolean(baseline && draft && JSON.stringify(draft) !== JSON.stringify(draftOf(baseline)));
  const canReview = valid && changed && !loading && !busy && !conflict && !loadFailed;
  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    if (action.current) return;
    setDraft(previous => previous ? { ...previous, [key]: value } : previous); setReviewedVersion(null); setStatus("");
  }
  async function save() {
    if (action.current || !canReview || !baseline || !draft || reviewedVersion !== baseline.updatedAtMs) return;
    action.current = true; request.current++; setBusy(true); setError(""); setStatus("");
    const body = baseline.kind === "global"
      ? { freePoolLimit: Number(draft.freePoolLimit), supporterPoolLimit: Number(draft.supporterPoolLimit), expectedUpdatedAtMs: reviewedVersion }
      : { eligible: draft.eligible, specialSlotLimit: Number(draft.specialSlotLimit), expectedUpdatedAtMs: reviewedVersion,
        ...(baseline.realtimeEnabled !== null && draft.realtimeEnabled !== baseline.realtimeEnabled ? { realtimeEnabled: draft.realtimeEnabled } : {}) };
    try {
      const saved = parsePolicy(await api(path, "PATCH", body), kind, plan?.planId);
      if (!alive.current) return;
      if (saved.updatedAtMs <= baseline.updatedAtMs) throw new Error("Invalid saved capacity revision");
      request.current++; setLoading(false); setLoadFailed(false);
      setBaseline(saved); setDraft(draftOf(saved)); setConflict(false); setReviewedVersion(null);
      setStatus("容量の設定を保存しました。新しい枠数とプランの選択肢を適用しました。");
      onSaved?.();
    } catch (cause) {
      if (!alive.current) return;
      request.current++; setLoading(false);
      const failure = cause && typeof cause === "object" ? cause as { status?: number; code?: string } : {};
      setConflict(failure.status === 409 || failure.code === "AUTOMATION_PUSH_CAPACITY_CONFLICT"); setReviewedVersion(null); setError(feedback(cause));
    } finally { action.current = false; if (alive.current) setBusy(false); }
  }

  return <article aria-label={plan ? `${plan.label}の自動展開特殊枠` : "自動展開の共有枠"} className="space-y-3 rounded-xl border bg-card p-4">
    <h3 className="font-medium">{title}</h3>
    {loading ? <p role="status" className="text-sm">容量の設定を読み込み中…</p> : null}
    {baseline && draft ? <form noValidate className="space-y-4" onSubmit={event => {
      event.preventDefault(); if (canReview) { setReviewedVersion(baseline.updatedAtMs); setError(""); setStatus(""); }
    }}>
      <fieldset disabled={busy || loading} className="space-y-3">
        {baseline.kind === "global" ? <>
          <p className="text-sm text-muted-foreground">全利用者で共有する自動展開用の総枠です。ユーザーごとの通常の通知枠数とは別の設定です。支援者優先枠は無料共有枠と競合しません。X監視1件は個人の総登録上限も1枠消費します。</p>
          <p className="text-xs text-muted-foreground">無料・有償を問わず無料共有枠から使い、無料が満杯の場合は対象者の支援者優先枠、有償特殊枠の順に割り当てます。品質・確認間隔は現在の契約プランで決まります。</p>
          <div className="grid gap-4 sm:grid-cols-2">{(["freePoolLimit", "supporterPoolLimit"] as const).map(key => <label key={key} className="space-y-1 text-sm">
            <span className="block">{key === "freePoolLimit" ? "無料の全体枠数" : "支援者優先の全体枠数"}</span>
            <Input type="number" inputMode="numeric" min={0} max={100000} step={1} value={draft[key]} onChange={event => update(key, event.target.value)} aria-invalid={!validNumber(draft[key])} />
            <span className="block text-xs text-muted-foreground">全利用者合計。0〜100,000の整数</span>
          </label>)}</div><p className="text-xs text-muted-foreground">0は、その共有枠での新規受付を停止する設定です。</p>
        </> : <>
          <p className="text-sm text-muted-foreground">このプランのユーザー1人あたりの特殊枠です。利用すると既存のユーザー単位の通知枠も消費します。通常の通知枠数はこの画面では変更しません。</p>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={draft.eligible} disabled={!baseline.planEnabled && !draft.eligible} onChange={event => update("eligible", event.target.checked)} /><span>このプランをベーシック以上の特殊枠対象として指定する</span></label>
          <p className="text-xs text-muted-foreground">プラン名・価格・優先度では自動判定しません。対象となる有償プランを管理者が確認して指定してください。</p>
          {!baseline.planEnabled ? <p className="text-sm text-muted-foreground">このプランは無効です。対象化する前に通常のプラン設定で有効にしてください。対象から外す変更は保存できます。</p> : null}
          <label className="block max-w-sm space-y-1 text-sm"><span className="block">このプランの特殊枠数（ユーザーあたり）</span>
            <Input type="number" inputMode="numeric" min={0} max={100000} step={1} value={draft.specialSlotLimit} onChange={event => update("specialSlotLimit", event.target.value)} aria-invalid={!validNumber(draft.specialSlotLimit)} />
            <span className="block text-xs text-muted-foreground">0〜100,000の整数。0は特殊枠を割り当てません。</span>
          </label>
          <section aria-label="プランのリアルタイム通知" className="space-y-2 rounded-lg border p-3">
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={draft.realtimeEnabled}
              disabled={baseline.realtimeEnabled === null || !baseline.planEnabled && !draft.realtimeEnabled}
              onChange={event => update("realtimeEnabled", event.target.checked)} /><span>このプランでX通知のリアルタイムを選べるようにする</span></label>
            <p className="text-xs text-muted-foreground">利用者がリアルタイムを選ぶと、Xから通知が届き次第、プランの間隔を待たずに処理します。通常の送信上限・優先度と利用枠を適用します。設定は、下の確認画面から保存すると反映されます。</p>
            {baseline.realtimeEnabled === null ? <p className="text-xs text-muted-foreground">リアルタイムの設定は、対応するサーバーで利用できます。特殊枠の設定は引き続き保存できます。</p> : null}
          </section>
        </>}
      </fieldset>
      {reviewedVersion !== null ? <section aria-label="自動展開容量の変更確認" className="space-y-3 rounded-lg border bg-muted/30 p-3">
        <h4 className="font-medium">容量の変更内容を確認</h4>
        <table className="w-full text-left text-sm"><thead><tr><th>項目</th><th>現在</th><th>保存後</th></tr></thead><tbody>
          {baseline.kind === "global" ? <>
            <tr><th className="py-1 font-normal">無料の全体枠数</th><td>{baseline.freePoolLimit}</td><td>{Number(draft.freePoolLimit)}枠</td></tr>
            <tr><th className="py-1 font-normal">支援者優先の全体枠数</th><td>{baseline.supporterPoolLimit}</td><td>{Number(draft.supporterPoolLimit)}枠</td></tr>
          </> : <>
            <tr><th className="py-1 font-normal">特殊枠の対象</th><td>{baseline.eligible ? "対象" : "対象外"}</td><td>{draft.eligible ? "対象" : "対象外"}</td></tr>
            <tr><th className="py-1 font-normal">特殊枠数（ユーザーあたり）</th><td>{baseline.specialSlotLimit}</td><td>{Number(draft.specialSlotLimit)}枠</td></tr>
            {baseline.realtimeEnabled !== null ? <tr><th className="py-1 font-normal">X通知のリアルタイム選択</th><td>{baseline.realtimeEnabled ? "利用可" : "利用対象外"}</td><td>{draft.realtimeEnabled ? "利用可" : "利用対象外"}</td></tr> : null}
          </>}
        </tbody></table>
        <p className="text-xs text-muted-foreground">保存すると、枠数とプランの選択肢が更新されます。通知を利用できる対象者は、サービスの提供設定に従います。</p>
        <div className="flex flex-wrap gap-2"><Button type="button" disabled={!canReview || reviewedVersion !== baseline.updatedAtMs} onClick={() => void save()}>{busy ? "保存中…" : "この容量で保存"}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setReviewedVersion(null)}>容量の編集に戻る</Button></div>
      </section> : <Button type="submit" disabled={!canReview}>{plan ? "特殊枠の変更を確認" : "共有枠の変更を確認"}</Button>}
    </form> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <Button type="button" variant="outline" disabled={loading || busy} onClick={() => void load(true)}>{reloadLabel}</Button>
    {status ? <p role="status" className="text-sm">{status}</p> : null}
  </article>;
}

export function PushCapacityManager({ api, plans }: { api: CapacityAPI; plans: NotificationPlanPolicy[] }) {
  const [opened, setOpened] = useState(false);
  const [policyRevision, setPolicyRevision] = useState(0);
  const paidPlans = plans.filter(plan => plan.tier === "paid" && !plan.isBuiltin && !isReserved(plan.planId));
  return <section aria-label="新しい自動展開の容量設定" className="space-y-4 border-t pt-6">
    <div className="space-y-2"><h2 className="text-lg font-semibold">新しいX自動展開の容量設定</h2>
      <p className="text-sm">共用枠・特殊枠と、プランごとのリアルタイム通知の選択肢を管理します。通知を利用できる対象者は、サービスの提供設定に従います。</p>
      <p className="text-sm text-muted-foreground">1枠＝通知を監視するXアカウント1件です。Firefoxの購読数や受信接続数を表すものではありません。</p>
    </div>
    {!opened ? <Button type="button" variant="outline" onClick={() => setOpened(true)}>容量の設定を開く</Button> : <>
      <CapacityEditor api={api} onSaved={() => setPolicyRevision(value => value + 1)} />
      <h3 className="font-medium">有償プランの特殊枠</h3>
      {paidPlans.map(plan => <CapacityEditor key={plan.planId} api={api} plan={plan} onSaved={() => setPolicyRevision(value => value + 1)} />)}
      {!paidPlans.length ? <p className="text-sm text-muted-foreground">有償プランを作成すると、そのプランの特殊枠をここで設定できます。</p> : null}
      <PushCapacityDiagnostics api={api} refreshVersion={policyRevision} />
    </>}
  </section>;
}
