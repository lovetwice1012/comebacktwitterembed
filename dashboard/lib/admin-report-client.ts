import "server-only";
import { adminAgentEndpoint } from "@/lib/admin-agent";
import { reportErrorMessage, type AdminReportCache } from "@/lib/admin-report-status";

export type ReportKind = "overview" | "analytics" | "guild-preview" | "provider-preview";
type Row = Record<string, unknown>;
type RemoteReport = { report?: Row | null; cache?: AdminReportCache; key?: string; actionId?: string | null; status?: string; metadata?: Row; filters?: Row; lastSuccessfulActionId?: string | null };

export function independentReportsEnabled() { return Boolean(process.env.ADMIN_AGENT_TOKEN); }

export function reportForDashboard(kind: ReportKind, value: RemoteReport) {
  // Panels stop at cache.ready=false. Keep the old overview's pre-render shape valid.
  const empty = kind === "overview" ? { tables: [], totals: {}, recent: { audit24h: 0, errors24h: 0, topErrorTypes: [], latestMetrics: [] }, providerRows: [], analytics: null, health: { database: { ok: false }, environment: {} } } : {};
  return { ...(value.report || empty), reportMetadata: { ...value.metadata, kind, filters: value.filters, key: value.key, lastSuccessfulActionId: value.lastSuccessfulActionId }, cache: { ...value.cache, lastError: reportErrorMessage(value.cache?.lastError), lastErrorDetails: value.cache?.lastErrorDetails ?? value.cache?.lastError ?? null, ready: Boolean(value.report), refreshing: value.cache?.refreshing === true, refreshIntervalMs: 300000, source: "independent_report_worker", actionId: value.actionId, key: value.key } };
}

/** Read or queue a complete snapshot. Never fall back to heavy computation in Next. */
export async function getIndependentAdminReport(kind: ReportKind, filters: Row, actorId: string, forceRefresh = false) {
  const endpoint = adminAgentEndpoint(`reports/${kind}`);
  const headers = { authorization: `Bearer ${process.env.ADMIN_AGENT_TOKEN}`, "x-admin-actor": actorId, "content-type": "application/json" };
  const read = async (method: "GET" | "POST") => {
    const url = new URL(endpoint);
    if (method === "GET") url.searchParams.set("filters", JSON.stringify(filters));
    const response = await fetch(url, { method, headers, cache: "no-store", signal: AbortSignal.timeout(15000), body: method === "POST" ? JSON.stringify({ filters, force: forceRefresh }) : undefined });
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : value.error?.message || "独立レポートの取得に失敗しました");
    return value as RemoteReport;
  };
  const previous = await read("GET");
  // GET never starts work in the core; queue only through its durable dedicated report lane.
  const age = previous.cache?.updatedAt ? Date.now() - Date.parse(previous.cache.updatedAt) : Infinity;
  if (!previous.cache?.refreshing && (forceRefresh || (!previous.cache?.lastError && (!previous.report || age >= 300000)))) {
    try { return reportForDashboard(kind, await read("POST")); }
    catch (error) {
      if (!previous.report) throw error;
      return reportForDashboard(kind, { ...previous, cache: { ...previous.cache, lastError: error instanceof Error ? error.message : String(error), refreshing: false } });
    }
  }
  return reportForDashboard(kind, previous);
}
