"use client";

import { useEffect, useRef } from "react";

// Opt-in, in-memory diagnostics only. No URL, account, message, browser ID,
// network transmission or persistent sample storage is included.
type Page = "notifications" | "x_monitors" | "delivery_history" | "plans";
type Sample = { page: Page; outcome: "ready" | "error"; durationMs: number };
type Store = { snapshot: () => Sample[]; clear: () => void; add: (sample: Sample) => void };
declare global { interface Window { __cbtePageTimings?: Store } }

const limit = 64;
function enabled(): boolean {
  try { return window.sessionStorage.getItem("cbte.pageTiming") === "1"; } catch { return false; }
}
function store(): Store {
  if (window.__cbtePageTimings) return window.__cbtePageTimings;
  const samples: Sample[] = [];
  const result = { snapshot: () => samples.map(item => ({ ...item })), clear: () => { samples.length = 0; },
    add: (sample: Sample) => {
      if (!sample || !["notifications", "x_monitors", "delivery_history", "plans"].includes(sample.page)
        || !["ready", "error"].includes(sample.outcome) || !Number.isSafeInteger(sample.durationMs) || sample.durationMs < 0 || sample.durationMs > 120000) return;
      if (samples.length === limit) samples.shift(); samples.push({ page: sample.page, outcome: sample.outcome, durationMs: sample.durationMs });
    } };
  window.__cbtePageTimings = result;
  return result;
}

/** Measures from active component effect to the first paint after initial data success/error. */
export function useAnonymousPageTiming(page: Page, active: boolean, loading: boolean, failed: boolean) {
  const run = useRef<{ startedAt: number; complete: boolean; cancelled: boolean } | null>(null);
  useEffect(() => {
    if (!active || !enabled() || document.visibilityState !== "visible" || typeof window.performance?.now !== "function"
      || typeof window.requestAnimationFrame !== "function" || typeof window.cancelAnimationFrame !== "function") { run.current = null; return; }
    const sample = { startedAt: window.performance.now(), complete: false, cancelled: false }; run.current = sample;
    const onVisibility = () => { if (document.visibilityState !== "visible") sample.cancelled = true; };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { sample.cancelled = true; document.removeEventListener("visibilitychange", onVisibility); if (run.current === sample) run.current = null; };
  }, [page, active]);
  useEffect(() => {
    const sample = run.current;
    if (!active || loading || !sample || sample.cancelled || sample.complete) return;
    let second = 0;
    const first = window.requestAnimationFrame(() => { second = window.requestAnimationFrame(() => {
      if (sample.cancelled || sample.complete || run.current !== sample || document.visibilityState !== "visible" || !enabled()) return;
      const elapsed = window.performance.now() - sample.startedAt;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 120000) { sample.cancelled = true; return; }
      sample.complete = true;
      try { store().add({ page, outcome: failed ? "error" : "ready", durationMs: Math.round(elapsed / 10) * 10 }); } catch { /* Diagnostics must not affect the page. */ }
    }); });
    return () => { window.cancelAnimationFrame(first); if (second) window.cancelAnimationFrame(second); };
  }, [page, active, loading, failed]);
}
