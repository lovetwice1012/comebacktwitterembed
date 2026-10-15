"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
let modalDepth = 0;
let previousOverflow = "";
const dialogStack: HTMLDialogElement[] = [];

export function AutomationDialog({ title, children, onCancel, busy = false, error, open = true }: { title: string; children: ReactNode; onCancel: () => void; busy?: boolean; error?: string; open?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null), label = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    if (modalDepth++ === 0) previousOverflow = document.body.style.overflow;
    dialogStack.push(dialog);
    document.body.style.overflow = "hidden";
    if (!dialog.open) { dialog.showModal(); dialog.querySelector<HTMLElement>('input,select,textarea')?.focus(); }
    return () => {
      const wasTop = dialogStack.at(-1) === dialog;
      const position = dialogStack.indexOf(dialog); if (position >= 0) dialogStack.splice(position, 1);
      if (dialog.open) dialog.close(); if (--modalDepth === 0) document.body.style.overflow = previousOverflow;
      if (wasTop && previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);
  return <dialog ref={ref} aria-labelledby={label} aria-busy={busy || undefined} className="automation-dialog" onCancel={event => { event.preventDefault(); if (!busy && dialogStack.at(-1) === ref.current) onCancel(); }} onKeyDown={event => {
    const dialog = ref.current;
    if (event.key !== "Tab" || !dialog || dialogStack.at(-1) !== dialog) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"],summary')]
      .filter(node => !node.closest('[hidden],fieldset:disabled,details:not([open]) > :not(summary)') && node.tabIndex >= 0);
    if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
    const first = focusable[0], last = focusable.at(-1)!;
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }}>
    <header className="flex items-center justify-between gap-4 border-b p-4"><h2 id={label} className="font-semibold">{title}</h2><button type="button" disabled={busy} className="rounded border px-3 py-1.5 text-sm" onClick={() => { if (dialogStack.at(-1) === ref.current) onCancel(); }}>キャンセル</button></header>
    <div className="automation-dialog-body space-y-3 p-5">{error && <p role="alert" className="rounded border border-destructive p-3 text-sm text-destructive">{error}</p>}{children}</div>
  </dialog>;
}
