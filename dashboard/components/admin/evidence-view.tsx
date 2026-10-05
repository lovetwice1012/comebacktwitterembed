"use client";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
const pretty = (value: unknown) => JSON.stringify(value ?? null, null, 2);

export function RawEvidence({ value, label = "全項目・原文", expanded = false }: { value: unknown; label?: string; expanded?: boolean }) {
  const [filter, setFilter] = useState("");
  const [feedback, setFeedback] = useState("");
  const [isOpen, setIsOpen] = useState(expanded);
  const raw = useMemo(() => isOpen ? pretty(value) : "", [isOpen, value]);
  const displayed = filter ? raw.split("\n").filter(line => line.toLowerCase().includes(filter.toLowerCase())).join("\n") : raw;
  return <details open={isOpen} onToggle={event => setIsOpen(event.currentTarget.open)} className="rounded-md border p-3"><summary className="cursor-pointer text-sm font-medium">{label}</summary>{isOpen ? <div className="mt-3 space-y-2">
    <div className="flex flex-wrap gap-2"><Input className="max-w-xs" aria-label="原文検索" placeholder="原文を検索" value={filter} onChange={e => setFilter(e.target.value)} /><Button variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(raw); setFeedback("コピーしました"); } catch { setFeedback("コピーできません。原文を選択してください。"); } }}>全体をコピー</Button><Button variant="outline" onClick={() => { const u = URL.createObjectURL(new Blob([raw], { type: "application/json" })); const a = document.createElement("a"); a.href = u; a.download = "admin-evidence.json"; a.click(); URL.revokeObjectURL(u); }}>JSON保存</Button></div>
    {feedback ? <p className="text-xs">{feedback}</p> : null}<pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{displayed || "一致なし"}</pre>
  </div> : null}</details>;
}
