"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";

export function AutomationDialog({ title, children, onCancel, busy = false, error }: { title: string; children: ReactNode; onCancel: () => void; busy?: boolean; error?: string }) {
  const ref = useRef<HTMLDialogElement>(null), label = useId();
  useEffect(() => { const dialog = ref.current; if (dialog && !dialog.open) dialog.showModal(); return () => { if (dialog?.open) dialog.close(); }; }, []);
  return <dialog ref={ref} aria-labelledby={label} className="automation-dialog" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <header className="flex items-center justify-between gap-4 border-b p-4"><h2 id={label} className="font-semibold">{title}</h2><button type="button" disabled={busy} className="rounded border px-3 py-1.5 text-sm" onClick={onCancel}>キャンセル</button></header>
    <div className="space-y-3 p-5">{error && <p role="alert" className="rounded border border-destructive p-3 text-sm text-destructive">{error}</p>}{children}</div>
  </dialog>;
}
