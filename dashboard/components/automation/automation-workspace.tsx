"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { RuleEditor, type Rule, type Bindings } from "./rule-editor";
import { MonitorManager } from "./monitor-manager";
import { DeliveryHistory } from "./delivery-history";
import { DictionaryManager } from "./dictionary-manager";
import { MarketplaceManager } from "./marketplace-manager";
import { recoveryKey, encodeRecovery, decodeRecovery } from "../../../src/automation/draft-recovery";
import "./automation.css";

const field = "w-full rounded border bg-background px-3 py-2 text-sm";
const button = "rounded border bg-background px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
const emptyBindings: Bindings = { destinations: {}, dictionaries: {} };
const download = (text: string, filename: string, mime = "application/json") => { const link = document.createElement("a"); const url = URL.createObjectURL(new Blob([text], { type: mime })); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url); };

export function AutomationWorkspace({ viewerId, guildId, canEdit = true }: { viewerId: string; guildId?: string; canEdit?: boolean }) {
  const [tab, setTab] = useState("monitors"), [catalog, setCatalog] = useState<any>(null), [items, setItems] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null), [draft, setDraft] = useState<Rule | null>(null), [bindings, setBindings] = useState<Bindings>(emptyBindings);
  const [editorValid, setEditorValid] = useState(false);
  const [destinations, setDestinations] = useState<any[]>([]), [dictionaries, setDictionaries] = useState<any[]>([]);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [goal, setGoal] = useState("all"), [time, setTime] = useState("now"), [display, setDisplay] = useState("expanded"), [scope, setScope] = useState("private");
  const [history, setHistory] = useState<any[]>([]), [resourceAlias, setResourceAlias] = useState("words");
  const [textDraft, setTextDraft] = useState<{ text: string; format: string } | null>(null), [recoveryReady, setRecoveryReady] = useState(false), [recoveryWarning, setRecoveryWarning] = useState("");
  const [recoveryFailed, setRecoveryFailed] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const actionsMenu = useRef<HTMLDetailsElement>(null), actionsToggle = useRef<HTMLElement>(null), historyPanel = useRef<HTMLElement>(null);
  const workspaceId = useId();
  const storageKey = recoveryKey(viewerId, guildId);
  const dirty = !!draft && (!!textDraft || !selected || JSON.stringify(draft) !== JSON.stringify(selected.draft) || JSON.stringify(bindings) !== JSON.stringify(selected.bindings));
  const api = useCallback(async (path: string, method = "GET", body?: any) => {
    const url = `/api/automation/${path}${path.includes("?") ? "&" : "?"}${guildId ? `guildId=${encodeURIComponent(guildId)}` : ""}`;
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || "操作に失敗しました。"), data);
    return data;
  }, [guildId]);
  useEffect(() => {
    let active = true;
    async function recover() {
      try {
        const raw = sessionStorage.getItem(storageKey);
        if (!raw) return;
        const record = decodeRecovery(raw, viewerId, guildId);
        // Re-authorize against the server before displaying an existing rule.
        const current = record.workflowId ? await api(`workflows/${record.workflowId}`) : null;
        if (!active) return;
        const conflict = current && Number(current.revision) !== record.baseRevision;
        setSelected(conflict ? null : current); setDraft(record.definition); setBindings(record.bindings);
        setTextDraft(record.textDraft); setScope(conflict ? "private" : record.scope); setTab("rules"); setStudioOpen(true); setEditorValid(false);
        setNotice(conflict ? "別の場所で更新されています。未保存の編集を新しい個人用の下書きとして復元しました。元のルールは変更しません。" : "未保存の編集を復元しました。まだ適用されていません。");
      } catch {
        if (active) { setRecoveryFailed(true); setRecoveryWarning("以前の編集を復元できませんでした。退避データは保持しています。期限・アクセス権を確認してください。"); }
      } finally { if (active) setRecoveryReady(true); }
    }
    void recover();
    return () => { active = false; };
  }, [api, viewerId, guildId, storageKey]);
  useEffect(() => {
    if (!recoveryReady) return;
    try {
      if (!dirty) { if (!recoveryFailed) { sessionStorage.removeItem(storageKey); setRecoveryWarning(""); } return; }
      sessionStorage.setItem(storageKey, encodeRecovery({ ownerId: viewerId, guildId, workflowId: selected?.id || null, baseRevision: selected?.revision || null, scope: selected?.scope || scope, definition: draft, bindings, textDraft }));
      setRecoveryWarning(""); setRecoveryFailed(false);
    } catch {
      try { sessionStorage.removeItem(storageKey); } catch { /* storage may be disabled */ }
      setRecoveryWarning("この編集はブラウザへ退避できません。秘密値・容量・保存設定を確認し、ページを閉じる前に保存してください。");
    }
  }, [recoveryReady, recoveryFailed, dirty, storageKey, viewerId, guildId, selected, scope, draft, bindings, textDraft]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const task = async (work: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await work(); } catch (err: any) { setError(err.message); } finally { setBusy(false); } };
  const refresh = useCallback(async () => {
    const [rules, dest, dict] = await Promise.all([api("workflows"), api("destinations"), api("dictionaries")]);
    setItems(rules.items); setDestinations(dest.items); setDictionaries(dict.items);
  }, [api]);
  useEffect(() => { api("catalog").then(setCatalog).catch(err => setError(err.message)); refresh().catch(err => setError(err.message)); }, [api, refresh]);
  useEffect(() => { if (new URLSearchParams(window.location.hash.slice(1)).has("automation-package")) setTab("marketplace"); }, []);
  useEffect(() => { if (history.length) { historyPanel.current?.focus(); historyPanel.current?.scrollIntoView({ block: "nearest" }); } }, [history]);
  function canReplaceDraft() { if (dirty && !confirm("未保存の編集を破棄してルールを切り替えますか？")) return false; setTextDraft(null); return true; }
  async function choose(item: any) { const value = await api(`workflows/${item.id}`); setSelected(value); setDraft(value.draft); setBindings(value.bindings); setTextDraft(null); setHistory([]); setStudioOpen(true); setEditorValid(false); }
  async function save() {
    if (!draft) return;
    if (!editorValid) throw new Error("ルールの検証が終わっていないか、未反映のテキストがあります。エディターを確認してください。");
    if (!selected) {
      const created = await api("workflows", "POST", { definition: draft, bindings, scope });
      setSelected(created); setDraft(created.draft); setBindings(created.bindings);
    } else {
      await api(`workflows/${selected.id}`, "PATCH", { definition: draft, bindings, expectedRevision: selected.revision });
      await choose(selected);
    }
    await refresh(); setNotice("下書きを保存しました。実行する版は「適用」で切り替わります。");
  }
  async function importPackage(file: File) {
    if (!canReplaceDraft()) return;
    if (file.size > 32 * 1024 * 1024) throw new Error("パッケージは32MiBまでです。");
    let body;
    if (file.name.endsWith(".zip")) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let raw = ""; for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
      body = { base64: btoa(raw) };
    } else body = { bundle: JSON.parse(await file.text()) };
    const preview = await api("import", "POST", { ...body, preview: true });
    if (!confirm(`${preview.workflow?.name || "辞書パック"} を${scope === "private" ? "個人用" : "サーバー共有"}の下書きとして取り込みますか？`)) return;
    const result = await api("import", "POST", { ...body, scope });
    await refresh(); if (result.workflow) await choose(result.workflow);
    setNotice("パッケージを下書きに取り込みました。通知先を割り当ててから適用してください。");
  }
  const inStudio = tab === "rules" && studioOpen && !!draft;
  return <div className={`automation-app space-y-3 ${inStudio ? "automation-studio" : ""}`}>
    {!inStudio && <><header className="automation-header"><h1 className="text-xl font-semibold">通知</h1><label className="flex items-center gap-2 text-sm">作成先<select className={field} value={scope} onChange={e => setScope(e.target.value)}><option value="private">自分だけ</option>{guildId && canEdit && <option value="guild">サーバー共有</option>}</select></label></header>
    <nav className="automation-navigation" aria-label="通知メニュー">{[["monitors", "通知一覧"], ["rules", "スタジオ"], ["history", "配信予定・履歴"], ["dictionaries", "辞書"], ["marketplace", "共有ルール"]].map(([id, name]) => <button key={id} disabled={!recoveryReady || busy} aria-current={tab === id ? "page" : undefined} onClick={() => { setTab(id); void task(refresh); }}>{name}</button>)}</nav></>}
    {error && <p role="alert" className="rounded border border-destructive bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {recoveryWarning && <p role="alert" className="rounded border border-amber-500 p-3 text-sm">{recoveryWarning}</p>}
    {catalog?.deliverySafety?.available === false && !inStudio && <p role="status" className="rounded border border-amber-500 p-3 text-sm">機械チェックを利用できないため、送信・公開は失敗として終了します。時間をおいて再試行してください。</p>}
    {dirty && !inStudio && <p role="status" className="text-xs text-muted-foreground">未保存 · 秘密値を含まない編集はこのブラウザのタブに24時間退避します</p>}
    {tab === "monitors" && <MonitorManager api={api} guildId={guildId} canEdit={canEdit} scope={scope} destinations={destinations} rules={items} refresh={refresh} />}
    {tab === "history" && <DeliveryHistory api={api} canEdit={canEdit} />}
    {tab === "rules" && <>
      {studioOpen && draft ? <nav className="automation-workspace-navigation" aria-label="スタジオの移動"><button className={button} disabled={busy} onClick={() => setStudioOpen(false)}>ルール一覧へ</button><div><button className={button} disabled={busy} onClick={() => setTab("monitors")}>通知一覧</button><button className={button} disabled={busy} onClick={() => setTab("history")}>配信予定・履歴</button></div></nav> : <>
      <div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => { if (canReplaceDraft()) void task(async () => { setSelected(null); setDraft(await api("template")); setBindings(emptyBindings); setStudioOpen(true); setEditorValid(false); }); }}>新しいルール</button>{draft && <button className={button} onClick={() => setStudioOpen(true)}>編集中のルールへ戻る</button>}<label className={button}>パッケージをインポート<input className="hidden" type="file" accept=".json,.zip" onChange={e => { const file = e.target.files?.[0]; if (file) void task(() => importPackage(file)); }} /></label></div>
      <div className="grid gap-2 md:grid-cols-3">{items.map(item => <button key={item.id} className="automation-library-card text-left" onClick={() => { if (canReplaceDraft()) void task(() => choose(item)); }}><div className="font-medium">{item.name}</div><div className="text-xs text-muted-foreground">{item.scope === "private" ? "個人用" : "サーバー共有"} · 下書き {item.revision} · {item.enabled ? `実行版 ${item.activeRevision}` : "停止中"}</div></button>)}</div>
      {catalog && <details className="rounded border p-3"><summary>目的別テンプレート（{catalog.templateCount}構成）</summary><div className="mt-3 flex flex-wrap gap-2"><select aria-label="目的" className={field + " max-w-64"} value={goal} onChange={e => setGoal(e.target.value)}>{catalog.goals.map((g: any) => <option key={g.id} value={g.id}>{g.label}</option>)}</select><select aria-label="配信時間" className={field + " max-w-48"} value={time} onChange={e => setTime(e.target.value)}>{catalog.times.map((t: any) => <option key={t.id} value={t.id}>{t.label}</option>)}</select><select aria-label="表示形式" className={field + " max-w-40"} value={display} onChange={e => setDisplay(e.target.value)}>{catalog.formats.map((f: string) => <option key={f}>{f}</option>)}</select><button className={button} onClick={() => { if (canReplaceDraft()) void task(async () => { setSelected(null); setDraft(await api(`template?goal=${goal}&time=${time}&format=${display}`)); setBindings(emptyBindings); setStudioOpen(true); setEditorValid(false); }); }}>テンプレートから作成</button></div></details>}
      </>}
      {studioOpen && draft && catalog && <fieldset disabled={busy} className="automation-workbench space-y-3">
        <header className="automation-workspace-heading nokey">
          <input aria-label="ルール名" className={field + " font-semibold"} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
          <div role="status" aria-label="ルールの状態" className="automation-workspace-status">
            <span data-unsaved={dirty} title={dirty ? "秘密値を含まない編集はこのブラウザのタブに24時間退避します" : undefined}>{dirty ? "未保存" : "保存済み"}</span>
            {selected && <span>下書き v{selected.revision}</span>}
            <span>{!selected?.activeRevision ? "未適用" : selected.enabled ? `実行版 v${selected.activeRevision}` : `停止中 · 適用版 v${selected.activeRevision}`}</span>
          </div>
          <div className="automation-workspace-actions">
            <button className={button + " automation-save-primary"} disabled={busy || !editorValid || selected?.scope === "guild" && !canEdit} title="実行版を変えずに下書きを保存" onClick={() => void task(save)}>下書きを保存</button>
            <button className={button + " automation-apply-secondary"} disabled={busy || !selected || !editorValid || selected.scope === "guild" && !canEdit} title={!selected ? "下書きを保存してから適用してください" : "編集内容を保存し、実行版を切り替えます"} onClick={() => { if (!selected) return; void task(async () => { await save(); const saved = await api(`workflows/${selected.id}`); await api(`workflows/${saved.id}/activate`, "POST", { expectedRevision: saved.revision }); await choose(saved); await refresh(); setNotice("ルールを適用しました。監視への割り当てがある場合、その監視の配信に使用します。"); }); }}>適用</button>
            {selected && <details ref={actionsMenu} className="automation-workspace-menu" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); if (actionsMenu.current) actionsMenu.current.open = false; actionsToggle.current?.focus(); } }}>
              <summary ref={actionsToggle}>ルール操作</summary>
              <div className="automation-workspace-menu-content">
                <div role="group" aria-label="実行の切り替え"><h2>実行</h2>
                  <button className={button} disabled={busy || !selected.activeRevision || selected.scope === "guild" && !canEdit} title={!selected.activeRevision ? "まず下書きを適用してください" : undefined} onClick={() => void task(async () => { await api(`workflows/${selected.id}/state`, "POST", { expectedRevision: selected.revision, enabled: !selected.enabled }); setSelected(await api(`workflows/${selected.id}`)); await refresh(); })}>{selected.enabled ? "停止" : "再開"}</button>
                </div>
                <div role="group" aria-label="ルールの再利用"><h2>再利用</h2><div>
                  <button className={button} disabled={!editorValid} onClick={() => void task(async () => { const copy = await api("workflows", "POST", { scope, definition: { ...draft, name: `${draft.name} のコピー`.slice(0, 120) }, bindings }); await refresh(); await choose(copy); })}>複製</button>
                  <button className={button} onClick={() => { if (dirty && !confirm("未保存の編集は含まれません。保存済みの下書きをエクスポートしますか？")) return; void task(async () => { const data = await api(`workflows/${selected.id}/export`); download(JSON.stringify(data, null, 2), "automation-package.json"); }); }}>共有用エクスポート</button>
                </div><p>エクスポートは保存済みの下書き</p></div>
                <div role="group" aria-label="版の確認"><h2>版の確認</h2><button className={button} onClick={() => void task(async () => { setHistory(await api(`workflows/${selected.id}/history`)); if (actionsMenu.current) actionsMenu.current.open = false; })}>変更履歴</button></div>
                <div role="group" aria-label="ルールの削除" className="automation-workspace-danger"><h2>削除</h2>
                  <button className={`${button} text-destructive`} disabled={selected.scope === "guild" && !canEdit} onClick={() => { if (confirm("このルールを削除し、未送信の配信を取り消しますか？")) void task(async () => { await api(`workflows/${selected.id}`, "DELETE", { expectedRevision: selected.revision }); setSelected(null); setDraft(null); await refresh(); }); }}>削除</button>
                </div>
              </div>
            </details>}
          </div>
        </header>
        {history.length > 0 && <section ref={historyPanel} tabIndex={-1} className="automation-version-history nokey" aria-label="変更履歴">
          <div className="automation-version-history-heading"><h2>変更履歴</h2><button className={button} onClick={() => { setHistory([]); actionsToggle.current?.focus(); }}>履歴を閉じる</button></div>
          <div className="automation-version-history-list">{history.map(row => <div className="automation-version-row" data-workflow-revision={row.revision} key={row.revision}>
            <div id={`${workspaceId}-revision-${row.revision}`}><span>版 {row.revision}</span><time dateTime={new Date(row.createdAtMs).toISOString()}>{new Date(row.createdAtMs).toLocaleString()}</time>{row.revision === selected?.activeRevision && <span className="automation-version-badge">{selected.enabled ? "実行版" : "適用版"}</span>}{row.revision === selected?.revision && <span className="automation-version-badge">保存済みの下書き</span>}</div>
            <button className={button} aria-describedby={`${workspaceId}-revision-${row.revision}`} disabled={selected?.scope === "guild" && !canEdit} onClick={() => { if (dirty && !confirm("未保存の編集を置き換えて、この版を下書きに復元しますか？実行中の版は変わりません。")) return; void task(async () => { await api(`workflows/${selected.id}/restore`, "POST", { revision: row.revision, expectedRevision: selected.revision }); await choose(selected); }); }}>この版を下書きに復元</button>
          </div>)}</div>
        </section>}
        <RuleEditor key={selected?.id || "new"} onValidityChange={setEditorValid} value={draft} bindings={bindings} onChange={setDraft} catalog={catalog} api={api} readOnly={busy || selected?.scope === "guild" && !canEdit} initialTextDraft={textDraft} onTextDraftChange={setTextDraft} />
        <details><summary className="text-xs text-muted-foreground">説明</summary><textarea aria-label="ルール説明" className={field} value={draft.description || ""} onChange={e => setDraft({ ...draft, description: e.target.value })} /></details>
        <details className="rounded border p-3"><summary>辞書・通知先の割り当て</summary><p className="my-2 text-sm text-muted-foreground">default は監視に登録した通知先です。追加の名前を使うとブロックから宛先を分岐できます。</p><input aria-label="差し込み名" className={field} value={resourceAlias} onChange={e => setResourceAlias(e.target.value)} /><div className="mt-2 flex flex-wrap gap-2"><select className={field} aria-label="辞書を割り当て" value="" onChange={e => { const d = dictionaries.find(d => d.id === e.target.value); if (d) setBindings({ ...bindings, dictionaries: { ...bindings.dictionaries, [resourceAlias]: { id: d.id, revision: d.revision } } }); }}><option value="">辞書を選択</option>{dictionaries.map(d => <option key={d.id} value={d.id}>{d.name} / v{d.revision}</option>)}</select><select className={field} aria-label="通知先を割り当て" value="" onChange={e => e.target.value && setBindings({ ...bindings, destinations: { ...bindings.destinations, [resourceAlias]: e.target.value } })}><option value="">通知先を選択</option>{destinations.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>{Object.entries(bindings.dictionaries).map(([alias, ref]) => <div key={alias} className="text-sm">辞書: {alias} / v{ref.revision} <button onClick={() => setBindings({ ...bindings, dictionaries: Object.fromEntries(Object.entries(bindings.dictionaries).filter(([k]) => k !== alias)) })}>解除</button></div>)}{Object.keys(bindings.destinations).map(alias => <div key={alias} className="text-sm">通知先: {alias} <button onClick={() => setBindings({ ...bindings, destinations: Object.fromEntries(Object.entries(bindings.destinations).filter(([k]) => k !== alias)) })}>解除</button></div>)}</details>
      </fieldset>}
    </>}
    {tab === "dictionaries" && <DictionaryManager api={api} dictionaries={dictionaries} scope={scope} canEdit={canEdit} refresh={refresh} />}
    {tab === "marketplace" && <MarketplaceManager api={api} scope={scope} canEdit={canEdit} rules={items} dictionaries={dictionaries} currentRuleId={selected?.id} refresh={refresh} openRule={async id => { if (canReplaceDraft()) { await choose({ id }); setTab("rules"); } }} />}
  </div>;
}
