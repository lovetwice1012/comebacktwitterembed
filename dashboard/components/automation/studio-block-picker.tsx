"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowRight, Bell, BookOpen, CalendarClock, CircleStop, Clock3, Gauge, GitBranch, Layers3, Merge, Search, SlidersHorizontal, X, AlertTriangle, type LucideIcon } from "lucide-react";
import "./studio-block-picker.css";

type StudioBlockPickerProps = {
  catalog: any;
  onPick: (type: string) => void;
  onDragStart?: (type: string) => void;
  onDragEnd?: () => void;
  onPlace?: (type: string, x: number, y: number) => void;
  disabled?: boolean;
  unavailableTypes?: string[];
  contextText: string;
};

type BlockChoice = {
  type: string;
  category: string;
  icon: LucideIcon;
  description: string;
  keywords: string;
};

const choices: BlockChoice[] = [
  { type: "condition", category: "condition", icon: GitBranch, description: "キーワード・価格・作者で絞る", keywords: "条件 判定 分岐 絞り込み フィルター フィルタ キーワード タイトル 本文 作者 タグ 値下げ 割引 セール 金額 価格 比較 含む 一致 不一致 情報不足 if filter keyword price" },
  { type: "dictionary", category: "condition", icon: BookOpen, description: "辞書のキーワードと照合", keywords: "辞書 キーワード 単語 語句 照合 タイトル 本文 含む マッチ 一覧 リスト dictionary words keyword" },
  { type: "merge", category: "condition", icon: Merge, description: "同じ投稿の経路を合流", keywords: "合流 まとめる 経路 流れ 重複 同じ投稿 条件 どれか すべて and or merge join" },
  { type: "delay", category: "time", icon: Clock3, description: "指定した分数だけ待つ", keywords: "時間 待つ 待機 遅らせる 遅延 後 あと 分 時間 タイマー 検知 公開 delay wait timer" },
  { type: "schedule", category: "time", icon: CalendarClock, description: "曜日・時間帯を選ぶ", keywords: "時間 スケジュール 予定 通知時間 時間帯 曜日 平日 週末 土日 休日 朝 昼 夜 深夜 毎朝 毎日 除外日 休み 営業時間 タイムゾーン schedule calendar quiet" },
  { type: "limit", category: "quantity", icon: Gauge, description: "通知件数を制限", keywords: "件数 上限 制限 多すぎる 頻度 回数 ペース 抑える 数 量 通知過多 スパム limit throttle rate" },
  { type: "aggregate", category: "quantity", icon: Layers3, description: "複数の投稿をまとめて通知", keywords: "まとめ 集約 集計 新着 一括 ダイジェスト 最新 複数 件数 量 bundle aggregate digest batch" },
  { type: "transform", category: "delivery", icon: SlidersHorizontal, description: "通知文・表示形式を変える", keywords: "通知文 文章 内容 文面 テンプレート 差し込み 書き換え 置換 表示 形式 画像 動画 メディア リッチ カード URL リンク text transform format message" },
  { type: "send", category: "delivery", icon: Bell, description: "宛先へ通知を送る", keywords: "通知 送る 送信 配信 届ける 宛先 通知先 チャンネル Webhook Discord send notify destination" },
  { type: "stop", category: "delivery", icon: CircleStop, description: "この経路では送らない", keywords: "止める 終了 停止 通知しない 送らない 除外 広告 スキップ 中止 stop exclude skip" },
];

const categories = [
  { id: "all", label: "すべて" },
  { id: "condition", label: "条件" },
  { id: "time", label: "時間" },
  { id: "quantity", label: "件数" },
  { id: "delivery", label: "送信" },
  { id: "other", label: "その他" },
];
const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase("ja").trim();

export function StudioBlockPicker({ catalog, onPick, onDragStart, onDragEnd, onPlace, disabled = false, unavailableTypes = [], contextText }: StudioBlockPickerProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const instanceId = useId();
  const search = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const pointerDrag = useRef<{ id: number; type: string; x: number; y: number; active: boolean } | null>(null), suppressClick = useRef(false);
  useEffect(() => {
    if (!onPlace) return;
    const move = (event: PointerEvent) => {
      const drag = pointerDrag.current;
      if (!drag || drag.id !== event.pointerId) return;
      if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 6) { drag.active = true; suppressClick.current = true; onDragStart?.(drag.type); }
      if (drag.active) event.preventDefault();
    };
    const finish = (event: PointerEvent) => {
      const drag = pointerDrag.current;
      if (!drag || drag.id !== event.pointerId) return;
      pointerDrag.current = null;
      if (drag.active) { if (event.type === "pointerup") onPlace(drag.type, event.clientX, event.clientY); onDragEnd?.(); }
    };
    window.addEventListener("pointermove", move, { passive: false }); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); };
  }, [onPlace, onDragStart, onDragEnd]);
  const available = useMemo(() => {
    const known = choices.filter(choice => catalog.nodes?.[choice.type]);
    const other = Object.keys(catalog.nodes || {}).filter(type => type !== "start" && !choices.some(choice => choice.type === type)).map(type => ({ type, category: "other", icon: SlidersHorizontal, description: "", keywords: type }));
    return [...known, ...other];
  }, [catalog.nodes]);
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  const matching = available.filter(choice => {
    const label = catalog.nodes[choice.type]?.label || choice.type;
    const haystack = normalize(`${label} ${choice.description} ${choice.keywords}`);
    return terms.every(term => haystack.includes(term));
  });
  const visible = matching.filter(choice => category === "all" || category === choice.category);

  useEffect(() => { search.current?.focus(); }, []);

  function clearSearch() {
    setQuery("");
    setCategory("all");
    search.current?.focus();
  }

  return <section className="studio-block-picker" aria-label="追加するブロック">
    <header className="studio-block-picker-heading">
      {contextText && <div className="studio-block-picker-context"><ArrowRight size={15} aria-hidden="true" /><span>{contextText}</span></div>}
      <h2>ブロックを追加</h2>
    </header>
    <div className="studio-block-picker-search">
      <Search size={18} aria-hidden="true" />
      <label htmlFor={`${instanceId}-search`} className="sr-only">追加するブロックを検索</label>
      <input ref={search} id={`${instanceId}-search`} type="search" value={query} placeholder="値下げ、平日、まとめて通知" onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); results.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(); } }} />
      {query && <button type="button" aria-label="ブロックの検索をクリア" onClick={clearSearch}><X size={16} aria-hidden="true" /></button>}
    </div>
    <div className="studio-block-picker-categories" role="group" aria-label="ブロックの用途">
      {categories.filter(item => item.id === "all" || available.some(choice => choice.category === item.id)).map(item => <button type="button" key={item.id} aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>{item.label}</button>)}
    </div>
    <p className="studio-block-picker-count" role="status">{visible.length}種類</p>
    <div ref={results} className="studio-block-picker-grid" aria-label="選べるブロック">
      {visible.map(choice => {
        const Icon = choice.icon;
        const label = catalog.nodes[choice.type]?.label || choice.type;
        const unavailable = unavailableTypes.includes(choice.type);
        const inactive = disabled || unavailable;
        return <button type="button" key={choice.type} className="studio-block-choice" data-category={choice.category} aria-label={label} aria-describedby={`${instanceId}-${choice.type}-description${unavailable ? ` ${instanceId}-${choice.type}-unavailable` : ""}`} disabled={inactive} draggable={!inactive && !onPlace} onPointerDown={event => { suppressClick.current = false; if (onPlace && !inactive && event.button === 0 && event.pointerType !== "touch") pointerDrag.current = { id: event.pointerId, type: choice.type, x: event.clientX, y: event.clientY, active: false }; }} onDragStart={event => {
          if (inactive) { event.preventDefault(); return; }
          event.dataTransfer.setData("application/cbte-automation-block", choice.type);
          event.dataTransfer.effectAllowed = "copy";
          onDragStart?.(choice.type);
        }} onDragEnd={() => onDragEnd?.()} onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } if (!inactive) onPick(choice.type); }}>
          <span className="studio-block-choice-icon"><Icon size={21} aria-hidden="true" /></span>
          <span className="studio-block-choice-copy"><span className="studio-block-choice-title">{label}</span><span id={`${instanceId}-${choice.type}-description`} className="studio-block-choice-description">{choice.description}</span>{unavailable && <span id={`${instanceId}-${choice.type}-unavailable`} className="studio-block-choice-unavailable"><AlertTriangle size={12} aria-hidden="true" />接続済みの位置には追加できません</span>}</span>
          <ArrowRight className="studio-block-choice-arrow" size={16} aria-hidden="true" />
        </button>;
      })}
      {!visible.length && <div className="studio-block-picker-empty"><Search size={26} aria-hidden="true" />{category !== "all" && matching.length > 0 ? <button type="button" onClick={() => setCategory("all")}>すべての用途を表示（{matching.length}種類）</button> : <button type="button" onClick={clearSearch}>検索をクリア</button>}</div>}
    </div>
  </section>;
}
