"use client";

import { useEffect, useState, useSyncExternalStore, type SetStateAction } from "react";

export type AdminSection = "home" | "investigation" | "servers" | "analytics" | "operations" | "administration";
export type ManagementTab = "home" | "recovery" | "search" | "inspect" | "send" | "settings" | "operations" | "incidents" | "metrics" | "policies";
export type RecordSource = "runs" | "events" | "actions" | "incidents" | "notifications";
export type AdminLocation = {
  section: AdminSection; tab: ManagementTab; report: string;
  guildId: string; channelId: string; userId: string; messageId: string;
  from: string; to: string; outcome: string; source: RecordSource;
  selected: string; selectedSource: RecordSource; provider: string; inspectUrl: string;
};
const sections: AdminSection[] = ["home", "investigation", "servers", "analytics", "operations", "administration"];
const managementTabs: ManagementTab[] = ["home", "recovery", "search", "inspect", "send", "settings", "operations", "incidents", "metrics", "policies"];
const sources: RecordSource[] = ["runs", "events", "actions", "incidents", "notifications"];
const changed = "cbte-admin-location";
export const sectionTabs: Record<AdminSection, ManagementTab[]> = {
  home: ["home"], investigation: ["search", "inspect", "send", "incidents"], servers: ["settings"],
  analytics: ["metrics"], operations: ["operations", "recovery"], administration: ["policies"],
};
export function readAdminLocation(value: string): AdminLocation {
  const url = new URL(value || "/admin", "http://admin.local");
  const q = url.searchParams;
  const routeTab = url.pathname.endsWith("url-inspector") ? "inspect" : url.pathname.endsWith("send-message") ? "send" : url.pathname.endsWith("support-console") ? "search" : "home";
  const section = sections.includes(q.get("section") as AdminSection) ? q.get("section") as AdminSection : routeTab === "home" ? "home" : "investigation";
  const tab = managementTabs.includes(q.get("tab") as ManagementTab) && sectionTabs[section].includes(q.get("tab") as ManagementTab) ? q.get("tab") as ManagementTab : sectionTabs[section].includes(routeTab) ? routeTab : sectionTabs[section][0];
  const source = sources.includes(q.get("source") as RecordSource) ? q.get("source") as RecordSource : "runs";
  const selectedSource = sources.includes(q.get("selectedSource") as RecordSource) ? q.get("selectedSource") as RecordSource : source;
  return { section, tab, report: q.get("report") || "metrics", guildId: q.get("guildId") || "", channelId: q.get("channelId") || "", userId: q.get("userId") || "", messageId: q.get("messageId") || "", from: q.get("from") || "", to: q.get("to") || "", outcome: q.get("outcome") || "", source, selected: q.get("selected") || "", selectedSource, provider: q.get("provider") || "twitter", inspectUrl: q.get("inspectUrl") || "" };
}
export function adminLocationUrl(value: string, patch: Partial<AdminLocation>) {
  const url = new URL(value, "http://admin.local");
  for (const [key, val] of Object.entries(patch)) {
    if (val) url.searchParams.set(key, val); else url.searchParams.delete(key);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
export function updateAdminLocation(patch: Partial<AdminLocation>, replace = false) {
  const next = adminLocationUrl(window.location.href, patch);
  if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  window.history[replace ? "replaceState" : "pushState"](window.history.state, "", next);
  window.dispatchEvent(new Event(changed));
}
function subscribe(callback: () => void) {
  window.addEventListener("popstate", callback); window.addEventListener(changed, callback);
  return () => { window.removeEventListener("popstate", callback); window.removeEventListener(changed, callback); };
}
export function useAdminLocation() {
  const value = useSyncExternalStore(subscribe, () => `${window.location.pathname}${window.location.search}`, () => "/admin");
  return readAdminLocation(value);
}
export function navigateAdmin(section: AdminSection, tab = sectionTabs[section][0]) {
  const current = readAdminLocation(window.location.href);
  const reports = section === "analytics" ? ["metrics", "overview", "analytics", "guildPreview", "providerPreview"] : section === "administration" ? ["policies", "logs", "database"] : [];
  updateAdminLocation({ section, tab, selected: "", ...(reports.length && !reports.includes(current.report) ? { report: reports[0] } : {}), ...(tab === "incidents" ? { source: "incidents" as const } : {}) });
}
export function jstInput(time: number) { return new Date(time + 9 * 3600000).toISOString().slice(0, 16); }
export function dateRange(hours: number) { const now = Date.now(); return { from: jstInput(now - hours * 3600000), to: jstInput(now) }; }
export function parseMessageLink(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["discord.com", "www.discord.com", "canary.discord.com", "ptb.discord.com", "discordapp.com"].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/channels\/(\d{1,20})\/(\d{1,20})\/(\d{1,20})\/?$/);
    return match ? { guildId: match[1], channelId: match[2], messageId: match[3] } : null;
  } catch { return null; }
}
export function buildInvestigationQuery(state: AdminLocation, source: RecordSource = state.source) {
  const q = new URLSearchParams({ limit: "100" });
  // Incidents and notifications describe the entire service, not a guild/time cohort.
  if (source === "incidents" || source === "notifications") return q;
  for (const key of ["guildId", "channelId", "userId", "messageId"] as const) if (state[key].trim()) q.set(key, state[key].trim());
  for (const key of ["from", "to"] as const) if (state[key]) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(state[key])) throw new Error("日時の形式を確認してください");
    const ms = Date.parse(`${state[key]}:00+09:00`);
    if (!Number.isFinite(ms)) throw new Error("日時が不正です");
    q.set(key, new Date(ms).toISOString());
  }
  if (q.get("from") && q.get("to") && q.get("from")! >= q.get("to")!) throw new Error("終了日時は開始日時より後にしてください");
  if (source === "runs" && state.outcome) q.set("outcome", state.outcome);
  return q;
}
export function verifyInvestigationFilters(source: RecordSource, query: URLSearchParams, data: Record<string, unknown>) {
  const keys = source === "actions" ? ["guildId", "channelId", "userId", "messageId", "from", "to"] : source === "runs" || source === "events" ? ["channelId", "userId", "messageId"] : [];
  const applied = data.appliedFilters as Record<string, unknown> | undefined;
  if (keys.some(key => query.get(key) && applied?.[key] !== query.get(key))) throw new Error("管理APIが指定した検索条件に対応していません。管理デーモンを更新してから再検索してください。");
}
export const resultLabels: Record<string, string> = { F: "完全成功", D: "代替成功", P: "部分成功", E: "失敗", U: "送信結果不明", S: "設定で見送り", C: "取得対象の制約", I: "処理中", X: "完了不明", queued: "受付済み", running: "実行中", succeeded: "完了", failed: "失敗", unknown: "成否未確認", Detected: "検知", Diagnosing: "診断中", Remediating: "修復中", Verifying: "復旧確認中", Resolved: "解決済み", Suppressed: "抑制中" };

export function useReportFilters<T extends Record<string, string>>(prefix: string, defaults: T): [T, (next: SetStateAction<T>) => void] {
  const snapshot = useSyncExternalStore(subscribe, () => window.location.search, () => "");
  function read(search: string) {
    const q = new URLSearchParams(search), shared: Record<string, string> = { guildId: "guildId", dateFrom: "from", dateTo: "to" };
    return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, q.get(shared[key] || `${prefix}.${key}`) ?? value])) as T;
  }
  const [filters, setFilters] = useState<T>(() => read(snapshot));
  useEffect(() => { setFilters(read(snapshot)); /* URL is authoritative on reload/back. */ }, [snapshot]);
  return [filters, next => {
    const value = typeof next === "function" ? next(filters) : next;
    setFilters(value);
    const url = new URL(window.location.href), shared: Record<string, string> = { guildId: "guildId", dateFrom: "from", dateTo: "to" };
    for (const [key, val] of Object.entries(value)) { const queryKey = shared[key] || `${prefix}.${key}`; if (val) url.searchParams.set(queryKey, val); else url.searchParams.delete(queryKey); }
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`); window.dispatchEvent(new Event(changed));
  }];
}
