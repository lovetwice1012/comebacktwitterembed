"use client";

import Link from "next/link";
import {
  Activity,
  BarChart3,
  ClipboardList,
  Database,
  FileClock,
  Gauge,
  Loader2,
  RefreshCcw,
  Save,
  Search,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { SignOutButton } from "@/components/dashboard/auth-buttons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { DashboardUser, SettingState } from "@/lib/types";

type AdminTab = "overview" | "analytics" | "guildPreview" | "providerPreview" | "logs" | "database" | "support";
type Row = Record<string, unknown>;

type TableSummary = {
  table: string;
  label: string;
  available: boolean;
  count: number;
  error?: string;
};

type AdminOverview = {
  generatedAt: string;
  durationMs: number;
  tables: TableSummary[];
  totals: Record<string, number>;
  recent: {
    audit24h: number;
    errors24h: number;
    topErrorTypes: Row[];
    latestMetrics: Row[];
  };
  providerRows: Row[];
  analytics: AdminAnalytics | null;
  health: {
    database: { ok: boolean; latencyMs: number; serverTime: unknown };
    environment: Record<string, unknown>;
  };
};

type AdminAnalytics = {
  windows: {
    generatedAt: string;
    dayStart: string;
    weekStart: string;
    monthStart: string;
  };
  kpis: Record<string, number | null>;
  metricTotals24h: Row[];
  metricTotals7d: Row[];
  providerReliability24h: Row[];
  providerReliability7d: Row[];
  hourlyTrend24h: Row[];
  topGuilds24h: Row[];
  topEndpoints24h: Row[];
  commandUsage24h: Row[];
  userUsage24h: Row[];
  providerAccountSummary7d: Row[];
  providerAccountHourly7d: Row[];
  providerGuildShare7d: Row[];
  providerContentHourly7d: Row[];
  providerContentGuildShare7d: Row[];
  providerContentFacets7d: Row[];
  providerContentUrls7d: Row[];
  urlAnalytics7d: Row[];
  mediaDelivery7d: Row[];
  audienceInterest7d: Row[];
  audit7d: {
    actions: Row[];
    actors: Row[];
    guilds: Row[];
  };
  errorBreakdown24h: {
    commands: Row[];
    components: Row[];
    httpStatuses: Row[];
  };
  analyticsQuality: {
    missingNativeAnalytics: Row[];
    enrichmentReliability: Row[];
    extractVsEnrichment: Row[];
    enrichmentSchemaVersions: Row[];
    enrichmentQueueOutcomes: Row[];
    providerRateLimits: Row[];
    providerDataErrors: Row[];
    metricNullRates: Row[];
    metricObservationQuality: Row[];
    requiredMetricCoverage: Row[];
    metricSchemaDrift: Row[];
    enrichmentSlo: Row[];
  };
  derivedAggregates: {
    summary: Row;
    providers: Row[];
    schemaVersions: Row[];
    operationalTrend: {
      hourly: Row[];
      providerAccounts: Row[];
      contentTypes: Row[];
    };
  };
  funnelAnalytics: Row[];
  settingChangeImpact: Row[];
  settingAttributionSummary: Row[];
  weeklyCohorts: Row[];
  contentLifetime: Row[];
  urlReuse: Row[];
  providerAccountHealth: Row[];
  providerAnomalySignals: Row[];
  seasonality30d: {
    hours: Row[];
    weekdays: Row[];
    providerWeekdays: Row[];
  };
  eventDaySpikes30d: {
    days: Row[];
    providers: Row[];
  };
  audienceCorrelation7d: Row[];
  decisionInsights: Row[];
  settingAdoption: Row[];
  autoExtract: {
    summary: Row;
    topUsers: Row[];
    topAccounts: Row[];
  };
};

type AdminDetailedAnalytics = {
  generatedAt: string;
  durationMs: number;
  filters: Row;
  window: {
    startMs: number;
    endMs: number;
    startAt: string;
    endAt: string;
    bucketMs: number;
    bucket: string;
  };
  summary: {
    content: Row;
    analytics: Row;
  };
  timeSeries: Row[];
  providerAccounts: Row[];
  providerReliability: Row[];
  contentTypes: Row[];
  guildBreakdown: Row[];
  userBreakdown: Row[];
  urlBreakdown: Row[];
  valueDrivers: Row[];
  urlParameterBreakdown: Row[];
  providerSegments: Row[];
  facetBreakdown: Row[];
  numericFacetStats: Row[];
  guildAccountMatrix: Row[];
  hourDistribution: Row[];
  eventHourDistribution: Row[];
  commandBreakdown: Row[];
  interestBreakdown: Row[];
  failureReasons: Row[];
  rawSamples: Row[];
};

type AdminPreviewCard = {
  label: string;
  value: unknown;
  detail?: unknown;
  tone?: "default" | "warning" | "success" | "muted";
};

type AdminProviderMetricProfile = {
  mode: string;
  providerId: string | null;
  accountKey?: unknown;
  title: string;
  description: string;
  successCriteria?: string[];
  cards: AdminPreviewCard[];
  sections: Array<{
    id: string;
    title: string;
    description: string;
    rows: Row[];
  }>;
};

type AdminUserFacingPreview = {
  generatedAt: string;
  durationMs: number;
  audience: string;
  title: string;
  scopeLabel: string;
  status: {
    publicEnabled: boolean;
    adminPreviewOnly: boolean;
    rawDiscordMessagesStored: boolean;
    privacyMinGroupSize?: number;
    smallGroupsSuppressed?: boolean;
    personalIdentifiers?: string;
    channelIdentifiers?: string;
    messageIdentifiers?: string;
    rowLevelSamples?: string;
    rawUrlVisible?: boolean;
    normalizedUrlVisible?: boolean;
    urlVisibility?: "normalized" | "raw";
  };
  filters: Row;
  window: {
    startMs: number;
    endMs: number;
    startAt: string;
    endAt: string;
    bucketMs: number;
    bucket: string;
  };
  cards: AdminPreviewCard[];
  deliveryContextCards?: AdminPreviewCard[];
  metricProfile?: AdminProviderMetricProfile;
  summary: {
    content: Row;
    analytics: Row;
  };
  sections: Record<string, Row[] | Row>;
};

type AdminAuditLog = {
  auditLogId: string;
  guildId: unknown;
  providerId: unknown;
  settingKey: unknown;
  actorUserId: unknown;
  actorUsernameSnapshot: unknown;
  action: unknown;
  before: unknown;
  after: unknown;
  requestId: unknown;
  createdAt: unknown;
};

type AdminLogs = {
  auditLogs: AdminAuditLog[];
  errorEvents: Row[];
  limit: number;
};

type AdminDatabase = {
  selectedTable: string;
  tables: Array<{ name: string; label: string; orderBy: string }>;
  summary: TableSummary;
  columns: Row[];
  rows: Row[];
  limit: number;
};

type CatalogSetting = {
  key: string;
  label: string;
  kind: string;
  dbColumn?: string | null;
  choices?: Array<{ value: string; label: string }>;
};

type CatalogProvider = {
  providerId: string;
  label: string;
  enabledByDefault: boolean;
  settings: CatalogSetting[];
};

type SupportSettings = {
  guildId: string;
  providerId: string;
  providerLabel: string;
  settings: SettingState[];
  specs: CatalogSetting[];
  recentLogs: AdminAuditLog[];
};

const tabs = [
  { value: "guildPreview", label: "サーバー分析", icon: Activity },
  { value: "providerPreview", label: "マーケ分析", icon: ClipboardList },
  { value: "analytics", label: "詳細分析", icon: BarChart3 },
  { value: "overview", label: "統計", icon: Gauge },
  { value: "logs", label: "ログ", icon: FileClock },
  { value: "database", label: "DB", icon: Database },
  { value: "support", label: "サポート", icon: SlidersHorizontal },
] satisfies Array<{ value: AdminTab; label: string; icon: typeof Gauge }>;

const controlClass =
  "h-10 w-full rounded-md border bg-card px-3 text-sm outline-none transition focus:ring-2 focus:ring-ring";

function asNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function maybeNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCount(value: unknown) {
  if (value === null || value === undefined) return "-";
  const numeric = maybeNumber(value);
  return numeric === null ? formatCell(value) : numeric.toLocaleString("ja-JP");
}

function formatDate(value: unknown) {
  if (!value) return "-";
  const date = typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))
    ? new Date(Number(value))
    : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "short", timeStyle: "medium" }).format(date);
}

function formatCell(value: unknown) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatPercent(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return `${(numeric * 100).toFixed(1)}%`;
}

function withPercentRows(rows: Row[], keys: string[]) {
  return rows.map((row) => ({
    ...row,
    ...Object.fromEntries(keys.filter((key) => key in row).map((key) => [key, formatPercent(row[key])])),
  }));
}

type DisplayColumn = {
  label: string;
  key: string;
  format?: (value: unknown, row: Row) => unknown;
};

function displayRows(rows: Row[], columns: DisplayColumn[]) {
  return rows.map((row) => Object.fromEntries(columns.map((column) => [
    column.label,
    column.format ? column.format(row[column.key], row) : row[column.key],
  ])));
}

function displayUrl(_value: unknown, row: Row) {
  return row.url_display || row.content_url || row.raw_url || row.normalized_url;
}

function formatAverage(value: unknown, unit = "") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return `${numeric.toFixed(numeric >= 100 ? 0 : 1)}${unit}`;
}

function formatShortNumber(value: unknown) {
  const numeric = maybeNumber(value);
  if (numeric === null) return formatCell(value);
  if (Math.abs(numeric) >= 1000000) return `${(numeric / 1000000).toFixed(1)}M`;
  if (Math.abs(numeric) >= 1000) return `${(numeric / 1000).toFixed(1)}k`;
  return formatCount(numeric);
}

function formatEntity(row: Row | undefined, keys: string[], fallback = "未分類") {
  if (!row) return fallback;
  const parts = keys
    .map((key) => (key === "content_url" ? displayUrl(undefined, row) : row[key]))
    .map(formatCell)
    .filter((value) => value && value !== "-" && value !== "null")
    .slice(0, 2);
  return parts.length ? parts.join(" / ") : fallback;
}

function topBy(rows: Row[], valueKey: string) {
  return rows.reduce<Row | undefined>((best, row) => {
    if (!best) return row;
    return asNumber(row[valueKey]) > asNumber(best[valueKey]) ? row : best;
  }, undefined);
}

function signalLabel(value: unknown) {
  const text = String(value || "");
  const labels: Record<string, string> = {
    cross_guild_reach: "複数サーバーに広がっています",
    repeat_interest: "同じ層が繰り返し見ています",
    high_volume: "表示量が多いです",
    early_signal: "初期反応です",
    demand_with_reliability_risk: "需要はありますが成功率に注意です",
    core_driver: "主力要因",
    growth_driver: "伸びている要因",
    emerging_driver: "伸び始め",
    watch: "様子見",
  };
  return labels[text] || text || "-";
}

function sensitivityLabel(value: unknown) {
  const text = String(value || "");
  const labels: Record<string, string> = {
    high: "高",
    medium: "中",
    marketing: "マーケ用途",
    low: "低",
  };
  return labels[text] || text || "-";
}

function queryFamilyLabel(value: unknown) {
  const text = String(value || "");
  const labels: Record<string, string> = {
    campaign: "キャンペーン",
    ad_tracking: "広告計測",
    referral: "参照元",
    credential_risk: "認証情報の可能性",
    identifier_risk: "識別子の可能性",
    general: "一般",
  };
  return labels[text] || text || "-";
}

function formatWeekday(value: unknown) {
  const names = ["", "日", "月", "火", "水", "木", "金", "土"];
  const index = Number(value);
  return Number.isInteger(index) && names[index] ? `${names[index]}曜` : formatCell(value);
}

function formatLocalHourFromUtc(value: unknown) {
  const hour = Number(value);
  if (!Number.isFinite(hour)) return formatCell(value);
  const offsetHours = -new Date().getTimezoneOffset() / 60;
  const localHour = ((Math.round(hour + offsetHours) % 24) + 24) % 24;
  return `${String(localHour).padStart(2, "0")}:00`;
}

function pretty(value: unknown) {
  if (value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || `Request failed: ${res.status}`);
  return json as T;
}

function parseJsonLoose(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function StatCard({ label, value, tone = "default" }: { label: string; value: unknown; tone?: "default" | "warning" | "success" | "muted" }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">{formatCount(value)}</CardTitle>
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <Badge tone={tone}>{label}</Badge>
      </CardContent>
    </Card>
  );
}

function MetricCard({ label, value, tone = "default" }: { label: string; value: unknown; tone?: "default" | "warning" | "success" | "muted" }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">{formatCell(value)}</CardTitle>
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <Badge tone={tone}>{label}</Badge>
      </CardContent>
    </Card>
  );
}

function previewSectionRows(preview: AdminUserFacingPreview | null, key: string) {
  const value = preview?.sections[key];
  return Array.isArray(value) ? value : [];
}

function previewSectionRow(preview: AdminUserFacingPreview | null, key: string) {
  const value = preview?.sections[key];
  return value && !Array.isArray(value) ? value : {};
}

function formatPreviewValue(card: AdminPreviewCard) {
  const numeric = Number(card.value);
  if (Number.isFinite(numeric) && /率|rate/i.test(card.label) && numeric >= 0 && numeric <= 1) {
    return formatPercent(numeric);
  }
  if (Number.isFinite(numeric) && numeric >= 1000) return formatCount(numeric);
  if (Number.isFinite(numeric) && !Number.isInteger(numeric)) return numeric.toFixed(2);
  return formatCell(card.value);
}

function PreviewCards({ cards }: { cards: AdminPreviewCard[] }) {
  if (!cards.length) {
    return <div className="rounded-md border bg-card p-4 text-sm text-muted-foreground">データがありません</div>;
  }
  return (
    <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardHeader>
            <CardTitle className="text-2xl">{formatPreviewValue(card)}</CardTitle>
            <CardDescription>{card.label}</CardDescription>
          </CardHeader>
          <CardContent>
            <Badge tone={card.tone || "muted"}>{formatCell(card.detail || card.label)}</Badge>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

type InsightItem = {
  label: string;
  value: unknown;
  body: string;
  tone?: "default" | "warning" | "success" | "muted";
};

function InsightGrid({ items }: { items: InsightItem[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-md border bg-background p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="text-xs font-medium text-muted-foreground">{item.label}</div>
            <Badge tone={item.tone || "muted"}>{item.tone === "warning" ? "要確認" : item.tone === "success" ? "良好" : "確認"}</Badge>
          </div>
          <div className="mt-2 break-words text-xl font-semibold leading-tight">{formatCell(item.value)}</div>
          <p className="mt-1 break-words text-sm text-muted-foreground">{item.body}</p>
        </div>
      ))}
    </div>
  );
}

function ReportTrendChart({ title, rows, valueKey }: { title: string; rows: Row[]; valueKey: string }) {
  const recent = rows.slice(-14);
  const max = Math.max(...recent.map((row) => asNumber(row[valueKey])), 1);
  if (!recent.length) {
    return <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">{title}: データなし</div>;
  }

  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="mb-3 text-sm font-medium">{title}</div>
      <div className="flex h-36 items-end gap-1">
        {recent.map((row, index) => {
          const value = asNumber(row[valueKey]);
          const height = Math.max(6, Math.round((value / max) * 100));
          return (
            <div key={String(row.bucket_start_ms || index)} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <div
                className="w-full rounded-t bg-primary/70"
                style={{ height: `${height}%` }}
                title={`${formatDate(row.bucket_start_ms)} / ${formatCount(value)}`}
              />
              <span className="max-w-full break-words text-center text-[10px] text-muted-foreground">{formatShortNumber(value)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReportBarList({
  title,
  rows,
  valueKey,
  labelKeys,
  detailKeys = [],
}: {
  title: string;
  rows: Row[];
  valueKey: string;
  labelKeys: string[];
  detailKeys?: string[];
}) {
  const visibleRows = rows.filter((row) => maybeNumber(row[valueKey]) !== null).slice(0, 6);
  const max = Math.max(...visibleRows.map((row) => asNumber(row[valueKey])), 1);
  if (!visibleRows.length) {
    return <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">{title}: データなし</div>;
  }

  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="mb-3 text-sm font-medium">{title}</div>
      <div className="space-y-3">
        {visibleRows.map((row, index) => {
          const value = asNumber(row[valueKey]);
          const width = Math.max(4, Math.round((value / max) * 100));
          const detail = detailKeys.map((key) => `${key}: ${formatCell(row[key])}`).join(" / ");
          return (
            <div key={`${formatEntity(row, labelKeys)}-${index}`} className="space-y-1">
              <div className="flex items-start justify-between gap-3 text-sm">
                <span className="min-w-0 break-words">{formatEntity(row, labelKeys)}</span>
                <span className="shrink-0 font-medium">{formatCount(value)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded bg-background">
                <div className="h-full rounded bg-primary/70" style={{ width: `${width}%` }} />
              </div>
              {detail ? <div className="break-words text-xs text-muted-foreground">{detail}</div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReportHighlights({
  title,
  description,
  insights,
  trendRows,
  trendValueKey = "content_events",
  rankingTitle,
  rankingRows,
  rankingValueKey,
  rankingLabelKeys,
}: {
  title: string;
  description: string;
  insights: InsightItem[];
  trendRows: Row[];
  trendValueKey?: string;
  rankingTitle: string;
  rankingRows: Row[];
  rankingValueKey: string;
  rankingLabelKeys: string[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <InsightGrid items={insights} />
        <div className="grid gap-4 xl:grid-cols-2">
          <ReportTrendChart title="推移" rows={trendRows} valueKey={trendValueKey} />
          <ReportBarList title={rankingTitle} rows={rankingRows} valueKey={rankingValueKey} labelKeys={rankingLabelKeys} />
        </div>
      </CardContent>
    </Card>
  );
}

function ProviderMetricProfilePanel({ profile }: { profile?: AdminProviderMetricProfile }) {
  if (!profile) {
    return <div className="rounded-md border bg-card p-4 text-sm text-muted-foreground">サービス固有の指標を読み込めませんでした。</div>;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>{profile.title}</CardTitle>
            <CardDescription>サービスごとの意味に合わせた主要KPIだけを表示します。</CardDescription>
          </div>
          <Badge tone={profile.mode === "provider_specific" ? "success" : profile.mode === "select_provider" ? "warning" : "muted"}>
            {profile.mode === "provider_specific" ? "対象サービス" : profile.mode === "select_provider" ? "サービス未指定" : "共通指標"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {profile.cards.length ? <PreviewCards cards={profile.cards} /> : (
          <div className="rounded-md border bg-muted p-4 text-sm text-muted-foreground">
            サービスIDを指定すると、Twitter / YouTube などサービスごとの意味に合わせた主要KPIが表示されます。
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TrendBars({ rows }: { rows: Row[] }) {
  const recent = rows.slice(-24);
  const max = Math.max(...recent.map((row) => Number(row.extract_attempts || 0) + Number(row.send_attempts || 0) + Number(row.command_attempts || 0)), 1);
  if (!recent.length) return <div className="rounded-md border bg-card p-4 text-sm text-muted-foreground">データなし</div>;

  return (
    <div className="flex h-32 items-end gap-1 rounded-md border bg-card p-3">
      {recent.map((row, index) => {
        const total = Number(row.extract_attempts || 0) + Number(row.send_attempts || 0) + Number(row.command_attempts || 0);
        const height = Math.max(4, Math.round((total / max) * 100));
        return (
          <div
            key={String(row.hour_start_ms || index)}
            className="min-w-0 flex-1 rounded-t bg-primary/70"
            style={{ height: `${height}%` }}
            title={`${formatDate(row.hour_start_ms)} / ${total}`}
          />
        );
      })}
    </div>
  );
}

function AdvancedAnalyticsPanel({ analytics }: { analytics: AdminAnalytics | null }) {
  if (!analytics) {
    return <div className="rounded-md border bg-card p-4 text-sm text-muted-foreground">高度な統計を読み込めませんでした。</div>;
  }

  const autoSummary = analytics.autoExtract.summary || {};
  const analyticsQuality = analytics.analyticsQuality || {
    missingNativeAnalytics: [],
    enrichmentReliability: [],
    extractVsEnrichment: [],
    enrichmentSchemaVersions: [],
    enrichmentQueueOutcomes: [],
    providerRateLimits: [],
    providerDataErrors: [],
    metricNullRates: [],
    metricObservationQuality: [],
    requiredMetricCoverage: [],
    metricSchemaDrift: [],
    enrichmentSlo: [],
  };
  const derivedAggregates = analytics.derivedAggregates || {
    summary: {},
    providers: [],
    schemaVersions: [],
    operationalTrend: {
      hourly: [],
      providerAccounts: [],
      contentTypes: [],
    },
  };
  const aggregateSummary = derivedAggregates.summary || {};
  const aggregateOperationalTrend = derivedAggregates.operationalTrend || {
    hourly: [],
    providerAccounts: [],
    contentTypes: [],
  };
  const seasonality30d = analytics.seasonality30d || {
    hours: [],
    weekdays: [],
    providerWeekdays: [],
  };
  const eventDaySpikes30d = analytics.eventDaySpikes30d || {
    days: [],
    providers: [],
  };
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">アナリティクス</h2>
        <p className="text-sm text-muted-foreground">
          24時間・7日間の利用、信頼性、監査、設定採用状況を集計しています。
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <StatCard label="24h active guilds" value={analytics.kpis.activeGuilds24h} tone="success" />
        <StatCard label="7d active guilds" value={analytics.kpis.activeGuilds7d} />
        <StatCard label="Realtime guilds" value={analytics.kpis.realtimeDiscordGuilds} />
        <StatCard label="24h active providers" value={analytics.kpis.activeProviders24h} />
        <StatCard label="24h analytics events" value={analytics.kpis.analyticsEvents24h} />
        <StatCard label="24h analytics users" value={analytics.kpis.analyticsUsers24h} />
        <StatCard label="30d errors" value={analytics.kpis.errors30d} tone={analytics.kpis.errors30d ? "warning" : "muted"} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Decision insights</CardTitle>
          <CardDescription>異常、品質欠損、低 health、設定変更効果、media delivery 価値から優先対応を並べます</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable rows={withPercentRows(analytics.decisionInsights, ["current_rate", "baseline_rate", "delta_rate"])} maxColumns={9} />
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>24h activity trend</CardTitle>
            <CardDescription>extract / send / command の合計推移</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <TrendBars rows={analytics.hourlyTrend24h} />
            <DataTable
              rows={withPercentRows(analytics.hourlyTrend24h.slice(-8), ["extract_success_rate", "send_success_rate", "command_success_rate", "component_success_rate"])}
              maxColumns={8}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>24h metric totals</CardTitle>
            <CardDescription>記録された metric_name 別の件数</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={analytics.metricTotals24h} maxColumns={3} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Provider reliability 24h</CardTitle>
            <CardDescription>抽出成功率・送信成功率・失敗率</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              rows={withPercentRows(analytics.providerReliability24h, ["extract_success_rate", "extract_error_rate", "send_success_rate", "send_error_rate"])}
              maxColumns={10}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Provider reliability 7d</CardTitle>
            <CardDescription>短期ノイズをならした provider 別傾向</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              rows={withPercentRows(analytics.providerReliability7d, ["extract_success_rate", "extract_error_rate", "send_success_rate", "send_error_rate"])}
              maxColumns={10}
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Analytics native coverage 7d</CardTitle>
            <CardDescription>provider が native analytics を返せなかったケースを provider 別に確認します。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analyticsQuality.missingNativeAnalytics, ["missing_rate"])} maxColumns={5} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Enrichment reliability 7d</CardTitle>
            <CardDescription>追加 API の非同期 enrichment 成功率と遅延です。provider extract duration とは分離しています。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analyticsQuality.enrichmentReliability, ["success_rate", "failure_rate"])} maxColumns={9} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Extract vs enrichment impact</CardTitle>
            <CardDescription>Discord 応答に関わる extract と、非同期分析 enrichment の duration を provider 別に分けて比較します。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analyticsQuality.extractVsEnrichment, ["extract_success_rate", "enrichment_success_rate"])} maxColumns={10} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Enrichment schema versions</CardTitle>
            <CardDescription>schema_version ごとの job 数と成功率です。指標定義変更後の比較に使います。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analyticsQuality.enrichmentSchemaVersions, ["success_rate"])} maxColumns={7} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Enrichment queue outcomes</CardTitle>
            <CardDescription>retry/backoff 後の outcome と queue wait を provider/account/source 別に確認します。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={analyticsQuality.enrichmentQueueOutcomes} maxColumns={9} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Provider API rate limits</CardTitle>
            <CardDescription>rate limit を受けた provider/account/source と retry delay です。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={analyticsQuality.providerRateLimits} maxColumns={8} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Provider data quality errors</CardTitle>
            <CardDescription>API timeout / rate limit / parse failure / analytics contract violation を provider 別に確認します。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={analyticsQuality.providerDataErrors} maxColumns={5} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Metric null and coverage rates</CardTitle>
            <CardDescription>provider schema の expected metric ごとの欠損率と coverage を確認します</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analyticsQuality.metricNullRates, ["coverage_rate", "null_rate"])} maxColumns={10} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Required metric readiness</CardTitle>
            <CardDescription>Provider reports can be exposed only after required metrics are present with enough coverage.</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analyticsQuality.requiredMetricCoverage, ["required_coverage_rate", "observation_coverage_rate", "null_or_missing_rate"])} maxColumns={11} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Metric schema drift</CardTitle>
            <CardDescription>Observed provider metrics that are not registered in the schema registry.</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={analyticsQuality.metricSchemaDrift} maxColumns={10} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Enrichment SLO monitor</CardTitle>
            <CardDescription>Timeouts, rate limits, queue wait, and latency SLO breaches for async enrichment jobs.</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analyticsQuality.enrichmentSlo, ["success_rate", "failure_rate", "slo_breach_rate"])} maxColumns={12} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Metric observation quality</CardTitle>
            <CardDescription>Metric collection quality grouped by stage, source, and schema version.</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analyticsQuality.metricObservationQuality, ["success_rate", "failure_rate"])} maxColumns={10} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Derived aggregate health</CardTitle>
            <CardDescription>raw event から時間単位集計へ反映されている件数と鮮度です。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-4">
              <div className="rounded-md bg-muted p-3 text-sm">
                <div className="text-muted-foreground">aggregate rows</div>
                <div className="font-medium">{formatCount(aggregateSummary.aggregate_rows)}</div>
              </div>
              <div className="rounded-md bg-muted p-3 text-sm">
                <div className="text-muted-foreground">analytics coverage</div>
                <div className="font-medium">{formatPercent(aggregateSummary.analytics_event_coverage_rate)}</div>
              </div>
              <div className="rounded-md bg-muted p-3 text-sm">
                <div className="text-muted-foreground">latest bucket</div>
                <div className="font-medium">{formatDate(aggregateSummary.latest_bucket_ms)}</div>
              </div>
              <div className="rounded-md bg-muted p-3 text-sm">
                <div className="text-muted-foreground">aggregate lag</div>
                <div className="font-medium">{formatAverage(aggregateSummary.aggregate_lag_hours, "h")}</div>
              </div>
            </div>
            <DataTable rows={[aggregateSummary]} maxColumns={8} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Aggregate provider coverage</CardTitle>
            <CardDescription>provider 別に hourly aggregate へ入った content / analytics / enrichment を確認します。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(derivedAggregates.providers, ["enrichment_failure_rate"])} maxColumns={9} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Aggregate schema versions</CardTitle>
            <CardDescription>schema_version ごとの enrichment 件数を aggregate 由来で確認します。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(derivedAggregates.schemaVersions, ["enrichment_success_rate"])} maxColumns={7} />
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Aggregate operational trend 7d</CardTitle>
            <CardDescription>
              Heavy analytics computed from bot_provider_hourly_aggregates and bot_provider_hourly_unique_keys, including anonymized reach and URL uniqueness.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="mb-2 text-sm font-medium">Hourly aggregate reach</div>
              <DataTable
                rows={withPercentRows(aggregateOperationalTrend.hourly.slice(-24), ["extract_success_rate", "send_success_rate", "enrichment_success_rate", "sensitive_rate"])}
                maxColumns={11}
              />
            </div>
            <div>
              <div className="mb-2 text-sm font-medium">Provider/account aggregate volume</div>
              <DataTable
                rows={withPercentRows(aggregateOperationalTrend.providerAccounts, ["extract_success_rate", "send_success_rate", "enrichment_success_rate", "sensitive_rate"])}
                maxColumns={11}
              />
            </div>
            <div>
              <div className="mb-2 text-sm font-medium">Provider content type reach</div>
              <DataTable rows={withPercentRows(aggregateOperationalTrend.contentTypes, ["sensitive_rate"])} maxColumns={10} />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Funnel analytics 7d</CardTitle>
            <CardDescription>URL投稿から抽出成功、Discord送信成功、操作イベントまでの落ち方を provider/account 別に確認します。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analytics.funnelAnalytics, ["extract_success_rate", "send_success_rate", "interaction_rate", "media_delivery_rate"])} maxColumns={10} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Media delivery value 7d</CardTitle>
            <CardDescription>download / media route が実際に使われた量と失敗率を provider/account 別に確認します</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analytics.mediaDelivery7d, ["success_rate"])} maxColumns={9} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Provider account health</CardTitle>
            <CardDescription>人気、到達、成功率、鮮度、エラー率を合わせた運用ヘルススコアです。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analytics.providerAccountHealth, ["extract_success_rate", "enrichment_success_rate", "error_rate", "freshness_score"])} maxColumns={10} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Provider anomaly signals</CardTitle>
            <CardDescription>直近 1 時間を過去 24 時間と比較して、成功率低下・失敗率上昇・遅延悪化を検出します</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analytics.providerAnomalySignals, ["current_rate", "baseline_rate", "delta_rate"])} maxColumns={9} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Setting change impact</CardTitle>
            <CardDescription>設定変更前後 7 日の content events の変化です。小さい集計は秘匿されます。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analytics.settingChangeImpact, ["change_rate"])} maxColumns={9} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Weekly cohorts</CardTitle>
            <CardDescription>初回利用週ごとの継続率です。個人 ID は表示しません。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analytics.weeklyCohorts, ["retention_rate"])} maxColumns={6} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Setting attribution summary 30d</CardTitle>
            <CardDescription>Aggregate-backed usage, success, and reach changes grouped by setting key, action, and provider enable direction.</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              rows={withPercentRows(analytics.settingAttributionSummary || [], [
                "change_rate",
                "extract_success_rate_before",
                "extract_success_rate_after",
                "send_success_rate_before",
                "send_success_rate_after",
                "enrichment_success_rate_before",
                "enrichment_success_rate_after",
              ])}
              maxColumns={12}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Content lifetime 30d</CardTitle>
            <CardDescription>同じ URL / content がどれくらいの期間反応され続けているかを確認します。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={analytics.contentLifetime} maxColumns={9} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>URL reuse 30d</CardTitle>
            <CardDescription>同じ URL が複数サーバーに広がっているかを確認します。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={analytics.urlReuse} maxColumns={9} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Seasonality 30d</CardTitle>
            <CardDescription>Hourly and weekday demand from hourly aggregates, with anonymized unique reach.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="mb-2 text-sm font-medium">Hourly seasonality</div>
              <DataTable
                rows={withPercentRows(seasonality30d.hours, ["extract_success_rate", "send_success_rate", "enrichment_success_rate", "sensitive_rate"])}
                maxColumns={10}
              />
            </div>
            <div>
              <div className="mb-2 text-sm font-medium">Weekday seasonality</div>
              <DataTable
                rows={withPercentRows(seasonality30d.weekdays, ["extract_success_rate", "send_success_rate", "enrichment_success_rate", "sensitive_rate"])}
                maxColumns={10}
              />
            </div>
            <div>
              <div className="mb-2 text-sm font-medium">Provider weekday seasonality</div>
              <DataTable
                rows={withPercentRows(seasonality30d.providerWeekdays, ["extract_success_rate", "send_success_rate", "enrichment_success_rate", "sensitive_rate"])}
                maxColumns={10}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Audience correlation 7d</CardTitle>
            <CardDescription>Provider/account affinity computed from hashed aggregate unique keys, not raw user identifiers.</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analytics.audienceCorrelation7d || [], ["target_share", "baseline_share"])} maxColumns={11} />
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Event-day spikes 30d</CardTitle>
            <CardDescription>Daily aggregate spikes that can point to launches, external events, campaigns, or community moments.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="mb-2 text-sm font-medium">Daily spike candidates</div>
              <DataTable
                rows={withPercentRows(eventDaySpikes30d.days, ["extract_success_rate", "send_success_rate", "enrichment_success_rate", "sensitive_rate"])}
                maxColumns={11}
              />
            </div>
            <div>
              <div className="mb-2 text-sm font-medium">Provider event-day spike candidates</div>
              <DataTable
                rows={withPercentRows(eventDaySpikes30d.providers, ["extract_success_rate", "send_success_rate", "enrichment_success_rate", "sensitive_rate"])}
                maxColumns={11}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top active guilds 24h</CardTitle>
            <CardDescription>抽出・送信・コマンド・コンポーネント操作の多いサーバー</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analytics.topGuilds24h, ["extract_error_rate", "send_error_rate"])} maxColumns={9} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top endpoints 24h</CardTitle>
            <CardDescription>provider endpoint 別の抽出量と失敗率</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analytics.topEndpoints24h, ["extract_success_rate", "extract_error_rate"])} maxColumns={8} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Command usage ranking 24h</CardTitle>
            <CardDescription>コマンド別の実行回数、成功率、ユニークユーザー</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analytics.commandUsage24h, ["success_rate"])} maxColumns={9} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>User usage ranking 24h</CardTitle>
            <CardDescription>ユーザー別の利用量、provider/account の広がり</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={analytics.userUsage24h} maxColumns={9} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Provider account summary 7d</CardTitle>
            <CardDescription>各 provider が取得した content をアカウント単位で集計</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analytics.providerAccountSummary7d, ["sensitive_rate"])} maxColumns={10} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Provider account time distribution 7d</CardTitle>
            <CardDescription>provider/account ごとの時間帯分布</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={analytics.providerContentHourly7d} maxColumns={7} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Provider account guild share 7d</CardTitle>
            <CardDescription>provider/account ごとの guild 比率</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analytics.providerContentGuildShare7d, ["account_share"])} maxColumns={7} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Provider content facets 7d</CardTitle>
            <CardDescription>hashtag、duration、stats、カテゴリなど provider 固有の分析軸</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={analytics.providerContentFacets7d} maxColumns={9} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Provider content URLs 7d</CardTitle>
            <CardDescription>URL・タイトル単位の反応、ユニークユーザー、guild 数</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={analytics.providerContentUrls7d} maxColumns={9} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Audience interests 7d</CardTitle>
            <CardDescription>同じユーザーが他に反応した provider/account/endpoint</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={analytics.audienceInterest7d} maxColumns={9} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Audit actions 7d</CardTitle>
            <CardDescription>管理・設定変更の操作種別</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={analytics.audit7d.actions} maxColumns={3} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Audit actors 7d</CardTitle>
            <CardDescription>操作したユーザー別件数</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={analytics.audit7d.actors} maxColumns={4} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Audit guilds 7d</CardTitle>
            <CardDescription>操作対象サーバー別件数</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={analytics.audit7d.guilds} maxColumns={3} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Command errors 24h</CardTitle>
            <CardDescription>command_name と error_type</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={analytics.errorBreakdown24h.commands} maxColumns={4} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Component errors 24h</CardTitle>
            <CardDescription>component_id と error_type</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={analytics.errorBreakdown24h.components} maxColumns={4} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>HTTP errors 24h</CardTitle>
            <CardDescription>provider / HTTP status 別</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={analytics.errorBreakdown24h.httpStatuses} maxColumns={4} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Setting adoption</CardTitle>
            <CardDescription>provider 別の有効化率と主要カスタム設定数</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={withPercentRows(analytics.settingAdoption, ["enabled_rate"])} maxColumns={9} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Auto extract analytics</CardTitle>
            <CardDescription>自動抽出の利用状況</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-md bg-muted p-3 text-sm">
                <div className="text-muted-foreground">targets</div>
                <div className="font-medium">{formatCount(autoSummary.total_targets)}</div>
              </div>
              <div className="rounded-md bg-muted p-3 text-sm">
                <div className="text-muted-foreground">enabled</div>
                <div className="font-medium">{formatCount(autoSummary.enabled_targets)}</div>
              </div>
              <div className="rounded-md bg-muted p-3 text-sm">
                <div className="text-muted-foreground">users</div>
                <div className="font-medium">{formatCount(autoSummary.unique_users)}</div>
              </div>
            </div>
            <DataTable rows={analytics.autoExtract.topAccounts} maxColumns={4} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function DataTable({ rows, maxColumns = 8 }: { rows: Row[]; maxColumns?: number }) {
  const columns = useMemo(() => {
    const keys = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row)) keys.add(key);
      if (keys.size >= maxColumns) break;
    }
    return [...keys].slice(0, maxColumns);
  }, [rows, maxColumns]);

  if (!rows.length) {
    return <div className="rounded-md border bg-card p-4 text-sm text-muted-foreground">データなし</div>;
  }

  return (
    <div className="overflow-auto rounded-md border">
      <table className="min-w-full border-collapse text-left text-xs">
        <thead className="bg-muted text-muted-foreground">
          <tr>
            {columns.map((column) => (
              <th key={column} className="whitespace-normal break-words px-3 py-2 font-medium">{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={String(row.id || row.auditLogId || row.error_event_id || index)} className="border-t">
              {columns.map((column) => (
                <td key={column} className="min-w-24 max-w-[28rem] whitespace-normal break-words px-3 py-2 align-top" title={formatCell(row[column])}>
                  {formatCell(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OverviewPanel({ overview, onRefresh, refreshing }: { overview: AdminOverview; onRefresh: () => void; refreshing: boolean }) {
  const unavailable = overview.tables.filter((table) => !table.available);
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">管理統計</h2>
          <p className="text-sm text-muted-foreground">更新 {formatDate(overview.generatedAt)} / {overview.durationMs}ms</p>
        </div>
        <Button type="button" variant="outline" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCcw size={16} />}
          更新
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <StatCard label="サーバー" value={overview.totals.guilds} tone="success" />
        <StatCard label="ユーザー" value={overview.totals.users} />
        <StatCard label="設定行" value={overview.totals.settings} />
        <StatCard label="24h エラー" value={overview.recent.errors24h} tone={overview.recent.errors24h ? "warning" : "muted"} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Activity size={18} />稼働状態</CardTitle>
            <CardDescription>DB と主要環境の状態</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
            <div className="rounded-md bg-muted p-3">
              <div className="text-muted-foreground">DB</div>
              <div className="font-medium">{overview.health.database.ok ? "OK" : "NG"} / {overview.health.database.latencyMs}ms</div>
            </div>
            {Object.entries(overview.health.environment).map(([key, value]) => (
              <div key={key} className="rounded-md bg-muted p-3">
                <div className="text-muted-foreground">{key}</div>
                <div className="font-medium">{String(value)}</div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ClipboardList size={18} />24h 概況</CardTitle>
            <CardDescription>監査ログ {formatCount(overview.recent.audit24h)} 件</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <DataTable rows={overview.recent.topErrorTypes} maxColumns={5} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>プロバイダー設定行</CardTitle>
            <CardDescription>DB に保存済みの provider_id 別件数</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={overview.providerRows} maxColumns={4} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>テーブル状態</CardTitle>
            <CardDescription>{unavailable.length ? `${unavailable.length} 件のテーブルを確認できません` : "全テーブル確認済み"}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={overview.tables as unknown as Row[]} maxColumns={5} />
          </CardContent>
        </Card>
      </div>

      <AdvancedAnalyticsPanel analytics={overview.analytics} />
    </div>
  );
}

type DetailedFilterState = {
  providerId: string;
  accountKey: string;
  guildId: string;
  authorUserId: string;
  eventType: string;
  commandName: string;
  componentId: string;
  contentType: string;
  facetKey: string;
  dateFrom: string;
  dateTo: string;
  bucket: string;
  limit: string;
};

const defaultDetailedFilters: DetailedFilterState = {
  providerId: "",
  accountKey: "",
  guildId: "",
  authorUserId: "",
  eventType: "",
  commandName: "",
  componentId: "",
  contentType: "",
  facetKey: "",
  dateFrom: "",
  dateTo: "",
  bucket: "hour",
  limit: "50",
};

function buildDetailedAnalyticsSearch(filters: DetailedFilterState) {
  const search = new URLSearchParams();
  for (const [key, value] of [
    ["provider_id", filters.providerId],
    ["account_key", filters.accountKey],
    ["guild_id", filters.guildId],
    ["event_type", filters.eventType],
    ["command_name", filters.commandName],
    ["component_id", filters.componentId],
    ["content_type", filters.contentType],
    ["facet_key", filters.facetKey],
    ["date_from", filters.dateFrom],
    ["date_to", filters.dateTo],
    ["bucket", filters.bucket],
    ["limit", filters.limit],
  ] as const) {
    if (value.trim()) search.set(key, value.trim());
  }
  return search;
}

function DetailedAnalyticsPanel() {
  const [filters, setFilters] = useState<DetailedFilterState>(defaultDetailedFilters);
  const [analytics, setAnalytics] = useState<AdminDetailedAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadInitial() {
      setLoading(true);
      setError(null);
      try {
        const search = buildDetailedAnalyticsSearch(defaultDetailedFilters);
        const payload = await fetchJson<AdminDetailedAnalytics>(`/api/admin/analytics?${search.toString()}`);
        if (!cancelled) setAnalytics(payload);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "詳細分析の読み込みに失敗しました");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadInitial();
    return () => {
      cancelled = true;
    };
  }, []);

  function setFilter(key: keyof DetailedFilterState, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  async function load(nextFilters = filters) {
    setLoading(true);
    setError(null);
    try {
      const search = buildDetailedAnalyticsSearch(nextFilters);
      setAnalytics(await fetchJson<AdminDetailedAnalytics>(`/api/admin/analytics?${search.toString()}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "詳細分析の読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function reset() {
    setFilters(defaultDetailedFilters);
    await load(defaultDetailedFilters);
  }

  const contentSummary = analytics?.summary.content || {};
  const eventSummary = analytics?.summary.analytics || {};
  const scope = analytics?.filters.guildId ? `サーバー ${formatCell(analytics.filters.guildId)}` : "全サーバー";
  const period = analytics ? `${formatDate(analytics.window.startMs)} - ${formatDate(analytics.window.endMs)}` : "-";
  const detailedTimeSeries = analytics?.timeSeries || [];
  const detailedProviderAccounts = analytics?.providerAccounts || [];
  const detailedValueDrivers = analytics?.valueDrivers || [];
  const detailedFailures = analytics?.failureReasons || [];
  const topProviderAccount = topBy(detailedProviderAccounts, "content_events");
  const topValueDriver = topBy(detailedValueDrivers, "value_score");
  const topFailure = topBy(detailedFailures, "errors");
  const successRate = maybeNumber(eventSummary.success_rate);
  const detailedInsights: InsightItem[] = [
    {
      label: "一番反応がある対象",
      value: formatEntity(topProviderAccount, ["provider_id", "account_key"]),
      body: `${formatCount(topProviderAccount?.content_events)}件、${formatCount(topProviderAccount?.users)}ユーザー、${formatCount(topProviderAccount?.guilds)}サーバーで反応があります。`,
      tone: "success",
    },
    {
      label: "処理の安定性",
      value: formatPercent(eventSummary.success_rate),
      body: successRate === null ? "成功率を計算できるデータがありません。" : successRate >= 0.95 ? "抽出と送信はおおむね安定しています。" : "抽出または送信で失敗が目立ちます。失敗理由を確認してください。",
      tone: successRate !== null && successRate < 0.95 ? "warning" : "success",
    },
    {
      label: "伸びている要因",
      value: signalLabel(topValueDriver?.value_signal || topValueDriver?.value_tier),
      body: `${formatEntity(topValueDriver, ["provider_id", "account_key", "content_type", "content_url"])} が注目度 ${formatCount(topValueDriver?.value_score)} です。`,
      tone: "default",
    },
    {
      label: "先に見るべきリスク",
      value: topFailure ? formatEntity(topFailure, ["error_type", "provider_id"]) : "大きな失敗なし",
      body: topFailure ? `${formatCount(topFailure.errors)}件の失敗があります。HTTP/Discordコードと発生元を確認してください。` : "この範囲では目立つ失敗はありません。",
      tone: topFailure && asNumber(topFailure.errors) > 0 ? "warning" : "success",
    },
  ];

  const timeRows = displayRows(detailedTimeSeries, [
    { label: "時間", key: "bucket_start_ms", format: formatDate },
    { label: "展開数", key: "content_events" },
    { label: "利用ユーザー", key: "content_users" },
    { label: "サーバー", key: "content_guilds" },
    { label: "イベント", key: "analytics_events" },
    { label: "成功率", key: "success_rate", format: formatPercent },
    { label: "平均ms", key: "avg_duration_ms", format: (value) => formatAverage(value, "ms") },
  ]);
  const providerRows = displayRows(detailedProviderAccounts, [
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "展開数", key: "content_events" },
    { label: "利用ユーザー", key: "users" },
    { label: "サーバー", key: "guilds" },
    { label: "URL", key: "urls" },
    { label: "平均メディア", key: "avg_media_count", format: (value) => formatAverage(value) },
    { label: "平均秒", key: "avg_duration_seconds", format: (value) => formatAverage(value, "s") },
    { label: "最新", key: "latest_ms", format: formatDate },
  ]);
  const reliabilityRows = displayRows(analytics?.providerReliability || [], [
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "イベント種別", key: "event_type" },
    { label: "回数", key: "events" },
    { label: "成功", key: "successes" },
    { label: "失敗", key: "failures" },
    { label: "成功率", key: "success_rate", format: formatPercent },
    { label: "平均ms", key: "avg_duration_ms", format: (value) => formatAverage(value, "ms") },
  ]);
  const contentTypeRows = displayRows(analytics?.contentTypes || [], [
    { label: "サービス", key: "provider_id" },
    { label: "種類", key: "content_type" },
    { label: "展開数", key: "content_events" },
    { label: "アカウント", key: "accounts" },
    { label: "利用ユーザー", key: "users" },
    { label: "サーバー", key: "guilds" },
    { label: "平均秒", key: "avg_duration_seconds", format: (value) => formatAverage(value, "s") },
  ]);
  const guildRows = displayRows(analytics?.guildBreakdown || [], [
    { label: "サーバー", key: "guild_id" },
    { label: "展開数", key: "content_events" },
    { label: "サービス数", key: "providers" },
    { label: "アカウント", key: "accounts" },
    { label: "利用ユーザー", key: "users" },
    { label: "URL", key: "urls" },
  ]);
  const userRows = displayRows(analytics?.userBreakdown || [], [
    { label: "利用量", key: "usage_bucket" },
    { label: "ユーザー数", key: "users" },
    { label: "展開数", key: "content_events" },
    { label: "平均利用", key: "avg_events_per_user", format: (value) => formatAverage(value) },
    { label: "平均サービス数", key: "avg_providers_per_user", format: (value) => formatAverage(value) },
    { label: "平均URL", key: "avg_urls_per_user", format: (value) => formatAverage(value) },
    { label: "最新", key: "latest_ms", format: formatDate },
  ]);
  const urlRows = displayRows(analytics?.urlBreakdown || [], [
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "URL", key: "content_url", format: displayUrl },
    { label: "タイトル", key: "title" },
    { label: "投稿者", key: "author_name" },
    { label: "展開数", key: "content_events" },
    { label: "利用ユーザー", key: "users" },
    { label: "サーバー", key: "guilds" },
    { label: "最新", key: "latest_ms", format: formatDate },
  ]);
  const valueDriverRows = displayRows(analytics?.valueDrivers || [], [
    { label: "切り口", key: "driver_type" },
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "種類", key: "content_type" },
    { label: "URL", key: "content_url", format: displayUrl },
    { label: "注目度", key: "value_score" },
    { label: "理由", key: "value_signal", format: signalLabel },
    { label: "成功率", key: "success_rate", format: formatPercent },
    { label: "ユーザー", key: "users" },
    { label: "サーバー", key: "guilds" },
    { label: "最新", key: "latest_ms", format: formatDate },
  ]);
  const urlParameterRows = displayRows(analytics?.urlParameterBreakdown || [], [
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "種類", key: "content_type" },
    { label: "URLパラメータ", key: "query_key" },
    { label: "分類", key: "query_key_family", format: queryFamilyLabel },
    { label: "注意度", key: "privacy_sensitivity", format: sensitivityLabel },
    { label: "件数", key: "content_events" },
    { label: "ユーザー", key: "users" },
    { label: "サーバー", key: "guilds" },
    { label: "URLs", key: "urls" },
  ]);
  const providerSegmentRows = displayRows(analytics?.providerSegments || [], [
    { label: "サービス", key: "provider_id" },
    { label: "軸", key: "axis_label" },
    { label: "指標", key: "metric_label" },
    { label: "値", key: "facet_value" },
    { label: "件数", key: "events" },
    { label: "ユーザー", key: "users" },
    { label: "サーバー", key: "guilds" },
    { label: "URLs", key: "urls" },
    { label: "平均", key: "avg_numeric_value", format: (value) => formatAverage(value) },
    { label: "スコア", key: "segment_score" },
  ]);
  const facetRows = displayRows(analytics?.facetBreakdown || [], [
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "分析軸", key: "facet_key" },
    { label: "値", key: "facet_value" },
    { label: "回数", key: "events" },
    { label: "利用ユーザー", key: "users" },
    { label: "サーバー", key: "guilds" },
    { label: "平均値", key: "avg_numeric_value", format: (value) => formatAverage(value) },
  ]);
  const numericFacetRows = displayRows(analytics?.numericFacetStats || [], [
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "数値指標", key: "facet_key" },
    { label: "回数", key: "events" },
    { label: "平均", key: "avg_value", format: (value) => formatAverage(value) },
    { label: "最小", key: "min_value", format: (value) => formatAverage(value) },
    { label: "最大", key: "max_value", format: (value) => formatAverage(value) },
    { label: "合計", key: "sum_value", format: (value) => formatAverage(value) },
  ]);
  const guildAccountRows = displayRows(analytics?.guildAccountMatrix || [], [
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "サーバー", key: "guild_id" },
    { label: "展開数", key: "content_events" },
    { label: "利用ユーザー", key: "users" },
    { label: "URL", key: "urls" },
  ]);
  const hourRows = displayRows(analytics?.hourDistribution || [], [
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "UTC時間帯", key: "hour_utc", format: (value) => `${formatCell(value)}:00` },
    { label: "展開数", key: "content_events" },
    { label: "利用ユーザー", key: "users" },
    { label: "サーバー", key: "guilds" },
  ]);
  const eventHourRows = displayRows(analytics?.eventHourDistribution || [], [
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "イベント", key: "event_type" },
    { label: "UTC時間帯", key: "hour_utc", format: (value) => `${formatCell(value)}:00` },
    { label: "回数", key: "events" },
    { label: "成功率", key: "success_rate", format: formatPercent },
    { label: "平均ms", key: "avg_duration_ms", format: (value) => formatAverage(value, "ms") },
  ]);
  const commandRows = displayRows(analytics?.commandBreakdown || [], [
    { label: "イベント", key: "event_type" },
    { label: "操作", key: "action_key" },
    { label: "回数", key: "events" },
    { label: "加重回数", key: "weighted_events" },
    { label: "成功率", key: "success_rate", format: formatPercent },
    { label: "利用ユーザー", key: "users" },
    { label: "サーバー", key: "guilds" },
    { label: "平均ms", key: "avg_duration_ms", format: (value) => formatAverage(value, "ms") },
  ]);
  const interestRows = displayRows(analytics?.interestBreakdown || [], [
    { label: "対象サービス", key: "target_provider_id" },
    { label: "対象アカウント", key: "target_account_key" },
    { label: "併読サービス", key: "interest_provider_id" },
    { label: "併読アカウント", key: "interest_account_key" },
    { label: "併読種類", key: "interest_content_type" },
    { label: "共起数", key: "co_events" },
    { label: "共通ユーザー", key: "shared_users" },
    { label: "共通サーバー", key: "shared_guilds" },
  ]);
  const failureReasonRows = displayRows(analytics?.failureReasons || [], [
    { label: "サービス", key: "provider_id" },
    { label: "発生元", key: "source" },
    { label: "失敗理由", key: "error_type" },
    { label: "重要度", key: "severity" },
    { label: "操作", key: "command_name" },
    { label: "HTTP", key: "http_status" },
    { label: "Discord", key: "discord_code" },
    { label: "失敗数", key: "errors" },
    { label: "ユーザー", key: "users" },
    { label: "最新", key: "latest_ms", format: formatDate },
  ]);
  const sampleRows = displayRows(analytics?.rawSamples || [], [
    { label: "時刻", key: "occurred_at_ms", format: formatDate },
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "種類", key: "content_type" },
    { label: "URL", key: "content_url", format: displayUrl },
    { label: "タイトル", key: "title" },
    { label: "サーバー", key: "guild_id" },
    { label: "匿名ユーザー", key: "author_user_id" },
  ]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">詳細分析</h2>
          <p className="text-sm text-muted-foreground">{scope} / {period} / {analytics ? `${analytics.durationMs}ms` : "読み込み中"}</p>
        </div>
        <Badge tone={analytics?.filters.guildId ? "success" : "muted"}>
          {analytics?.filters.guildId ? "サーバー管理者向けプレビュー" : "全体分析"}
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>分析条件</CardTitle>
          <CardDescription>サービス、アカウント、サーバー、期間、分析軸で同じ統計を切り替えます。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 lg:grid-cols-4">
            <Input value={filters.guildId} onChange={(event) => setFilter("guildId", event.target.value)} placeholder="サーバーID" />
            <Input value={filters.providerId} onChange={(event) => setFilter("providerId", event.target.value)} placeholder="サービスID" />
            <Input value={filters.accountKey} onChange={(event) => setFilter("accountKey", event.target.value)} placeholder="アカウント" />
            <Input value={filters.contentType} onChange={(event) => setFilter("contentType", event.target.value)} placeholder="種類" />
            <Input value={filters.facetKey} onChange={(event) => setFilter("facetKey", event.target.value)} placeholder="分析軸" />
            <Input value={filters.commandName} onChange={(event) => setFilter("commandName", event.target.value)} placeholder="操作名" />
            <Input value={filters.componentId} onChange={(event) => setFilter("componentId", event.target.value)} placeholder="ボタンID" />
          </div>
          <div className="grid gap-3 lg:grid-cols-[1fr_1fr_160px_120px_160px_auto]">
            <Input type="datetime-local" value={filters.dateFrom} onChange={(event) => setFilter("dateFrom", event.target.value)} />
            <Input type="datetime-local" value={filters.dateTo} onChange={(event) => setFilter("dateTo", event.target.value)} />
            <select className={controlClass} value={filters.eventType} onChange={(event) => setFilter("eventType", event.target.value)}>
              <option value="">全イベント</option>
              <option value="provider_extract">provider_extract</option>
              <option value="discord_send">discord_send</option>
              <option value="command">command</option>
              <option value="component">component</option>
              <option value="modal_submit">modal_submit</option>
            </select>
            <select className={controlClass} value={filters.bucket} onChange={(event) => setFilter("bucket", event.target.value)}>
              <option value="hour">時間別</option>
              <option value="day">日別</option>
            </select>
            <Input value={filters.limit} onChange={(event) => setFilter("limit", event.target.value)} inputMode="numeric" placeholder="表示件数" />
            <div className="flex gap-2">
              <Button type="button" onClick={() => load()} disabled={loading}>
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                分析
              </Button>
              <Button type="button" variant="outline" onClick={reset} disabled={loading}>
                <RefreshCcw size={16} />
              </Button>
            </div>
          </div>
          {error ? <div className="rounded-md border border-destructive/40 bg-card p-3 text-sm text-destructive">{error}</div> : null}
        </CardContent>
      </Card>

      <ReportHighlights
        title="レポート要約"
        description="まず見るべき反応量、安定性、伸びている要因、失敗リスクをまとめています。下の表は根拠データです。"
        insights={detailedInsights}
        trendRows={detailedTimeSeries}
        rankingTitle="反応が多いサービス/アカウント"
        rankingRows={detailedProviderAccounts}
        rankingValueKey="content_events"
        rankingLabelKeys={["provider_id", "account_key"]}
      />

      <div className="grid gap-3 md:grid-cols-4">
        <StatCard label="展開コンテンツ" value={contentSummary.content_events} tone="success" />
        <StatCard label="利用ユーザー" value={contentSummary.users} />
        <StatCard label="反応サーバー" value={contentSummary.guilds} />
        <StatCard label="対象アカウント" value={contentSummary.accounts} />
        <StatCard label="URL種類" value={contentSummary.urls} />
        <StatCard label="分析イベント" value={eventSummary.analytics_events} />
        <MetricCard label="成功率" value={formatPercent(eventSummary.success_rate)} tone={Number(eventSummary.success_rate || 0) >= 0.95 ? "success" : "warning"} />
        <MetricCard label="平均処理時間" value={formatAverage(eventSummary.avg_duration_ms, "ms")} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>時間推移</CardTitle>
            <CardDescription>展開数、利用ユーザー、成功率を時間ごとに確認します。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={timeRows} maxColumns={8} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>サービス/アカウント別</CardTitle>
            <CardDescription>どのアカウントがどのサーバーやユーザーに届いているかを見ます。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={providerRows} maxColumns={9} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>サービス別の成功率</CardTitle>
            <CardDescription>抽出、送信、コマンドなどのイベント種別ごとの安定性です。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={reliabilityRows} maxColumns={8} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>コンテンツ種類</CardTitle>
            <CardDescription>投稿、動画、画像などサービスごとの種類別の反応です。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={contentTypeRows} maxColumns={7} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>サーバー別の反応</CardTitle>
            <CardDescription>将来サーバー管理者へ見せる統計の元データです。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={guildRows} maxColumns={6} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>ユーザー別の利用量</CardTitle>
            <CardDescription>どのユーザー層が多く展開しているかを確認します。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={userRows} maxColumns={7} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>反応を伸ばしている要因</CardTitle>
          <CardDescription>サービス、アカウント、種類、URL のどれが反応量や継続利用に効いているかを並べます。</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable rows={valueDriverRows} maxColumns={11} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>流入パラメータ</CardTitle>
          <CardDescription>URL のパラメータ名だけを集計し、キャンペーンや参照元の傾向を見ます。値そのものは保存していません。</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable rows={urlParameterRows} maxColumns={10} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>マーケティング軸別の反応</CardTitle>
          <CardDescription>サービスごとの指標を、投稿形式・話題・数値レンジなどの軸で見やすくまとめます。</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable rows={providerSegmentRows} maxColumns={10} />
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>URL / 投稿別の反応</CardTitle>
            <CardDescription>URL、タイトル、投稿者単位での反応です。Discord の生メッセージは含みません。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={urlRows} maxColumns={9} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Facet 分析</CardTitle>
            <CardDescription>ハッシュタグ、メンション、再生数、動画時間などサービス固有の分析軸です。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={facetRows} maxColumns={8} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>数値指標</CardTitle>
            <CardDescription>再生数、いいね数、動画秒数など数値 facet の集計です。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={numericFacetRows} maxColumns={8} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>サーバー x アカウント</CardTitle>
            <CardDescription>各サーバーでどのサービス/アカウントが反応されているかを見ます。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={guildAccountRows} maxColumns={6} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>アカウント別の時間帯</CardTitle>
            <CardDescription>provider/account ごとの展開された時間帯分布です。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={hourRows} maxColumns={6} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>イベント別の時間帯</CardTitle>
            <CardDescription>コマンドや送信処理が成功しやすい時間帯を確認します。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={eventHourRows} maxColumns={7} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>操作ランキング</CardTitle>
            <CardDescription>コマンド、ボタン、抽出、送信などの利用ランキングです。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={commandRows} maxColumns={8} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>興味傾向</CardTitle>
            <CardDescription>同じユーザーがあわせて反応している provider/account の組み合わせです。</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={interestRows} maxColumns={8} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>最近の展開サンプル</CardTitle>
          <CardDescription>URL と展開時メタデータだけを確認します。Discord の生メッセージは保存・表示しません。</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable rows={sampleRows} maxColumns={8} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>失敗理由</CardTitle>
          <CardDescription>ユーザー、メッセージ、チャンネルを出さずに、失敗の種類と発生元だけを集計します。</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable rows={failureReasonRows} maxColumns={10} />
        </CardContent>
      </Card>
    </div>
  );
}

type GuildPreviewFilterState = {
  guildId: string;
  providerId: string;
  accountKey: string;
  contentType: string;
  dateFrom: string;
  dateTo: string;
  bucket: string;
  limit: string;
  urlVisibility: string;
};

type ProviderPreviewFilterState = GuildPreviewFilterState & {
  facetKey: string;
};

const defaultGuildPreviewFilters: GuildPreviewFilterState = {
  guildId: "",
  providerId: "",
  accountKey: "",
  contentType: "",
  dateFrom: "",
  dateTo: "",
  bucket: "day",
  limit: "40",
  urlVisibility: "raw",
};

const defaultProviderPreviewFilters: ProviderPreviewFilterState = {
  ...defaultGuildPreviewFilters,
  facetKey: "",
};

function buildGuildPreviewSearch(filters: GuildPreviewFilterState) {
  const search = new URLSearchParams();
  for (const [key, value] of [
    ["guild_id", filters.guildId],
    ["provider_id", filters.providerId],
    ["account_key", filters.accountKey],
    ["content_type", filters.contentType],
    ["date_from", filters.dateFrom],
    ["date_to", filters.dateTo],
    ["bucket", filters.bucket],
    ["limit", filters.limit],
    ["url_visibility", filters.urlVisibility],
  ] as const) {
    if (value.trim()) search.set(key, value.trim());
  }
  return search;
}

function buildProviderPreviewSearch(filters: ProviderPreviewFilterState) {
  const search = buildGuildPreviewSearch(filters);
  if (filters.facetKey.trim()) search.set("facet_key", filters.facetKey.trim());
  return search;
}

function GuildAdminPreviewPanel() {
  const [filters, setFilters] = useState<GuildPreviewFilterState>(defaultGuildPreviewFilters);
  const [preview, setPreview] = useState<AdminUserFacingPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadInitial() {
      setLoading(true);
      setError(null);
      try {
        const search = buildGuildPreviewSearch(defaultGuildPreviewFilters);
        const payload = await fetchJson<AdminUserFacingPreview>(`/api/admin/guild-analytics-preview?${search.toString()}`);
        if (!cancelled) setPreview(payload);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "サーバー分析プレビューの読み込みに失敗しました");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadInitial();
    return () => {
      cancelled = true;
    };
  }, []);

  function setFilter(key: keyof GuildPreviewFilterState, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  async function load(nextFilters = filters) {
    setLoading(true);
    setError(null);
    try {
      const search = buildGuildPreviewSearch(nextFilters);
      setPreview(await fetchJson<AdminUserFacingPreview>(`/api/admin/guild-analytics-preview?${search.toString()}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "サーバー分析プレビューの読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function reset() {
    setFilters(defaultGuildPreviewFilters);
    await load(defaultGuildPreviewFilters);
  }

  const retention = previewSectionRow(preview, "audienceRetention");
  const guildTimeSeries = previewSectionRows(preview, "timeSeries");
  const guildProviderAccounts = previewSectionRows(preview, "providerAccounts");
  const guildTopContent = previewSectionRows(preview, "topContent");
  const guildSummaryAnalytics = preview?.summary.analytics || {};
  const guildTopProvider = topBy(guildProviderAccounts, "content_events");
  const guildTopContentRow = topBy(guildTopContent, "content_events");
  const guildSuccessRate = maybeNumber(guildSummaryAnalytics.success_rate);
  const guildInsights: InsightItem[] = [
    {
      label: "このサーバーで人気",
      value: formatEntity(guildTopProvider, ["provider_id", "account_key"]),
      body: `${formatCount(guildTopProvider?.content_events)}件の表示、${formatCount(guildTopProvider?.users)}ユーザーが反応しています。`,
      tone: "success",
    },
    {
      label: "よく見られた投稿",
      value: formatEntity(guildTopContentRow, ["title", "content_url"]),
      body: `${formatCount(guildTopContentRow?.content_events)}件の表示があります。URLやタイトルは下のランキングで確認できます。`,
      tone: "default",
    },
    {
      label: "継続反応",
      value: formatPercent(retention.returning_rate),
      body: `${formatCount(retention.returning_users)}人が繰り返し反応しています。新規は ${formatCount(retention.first_seen_users)} 人です。`,
      tone: asNumber(retention.returning_users) > 0 ? "success" : "muted",
    },
    {
      label: "表示の安定性",
      value: guildSuccessRate !== null ? formatPercent(guildSuccessRate) : "確認中",
      body: guildSuccessRate === null ? "表示できた割合を計算できるデータがまだありません。" : guildSuccessRate >= 0.95 ? "投稿の展開は安定しています。" : "一部の投稿で表示まで届きにくい傾向があります。",
      tone: guildSuccessRate !== null && guildSuccessRate < 0.95 ? "warning" : "success",
    },
  ];
  const timeRows = displayRows(previewSectionRows(preview, "timeSeries"), [
    { label: "日付", key: "bucket_start_ms", format: formatDate },
    { label: "表示数", key: "content_events" },
    { label: "利用ユーザー", key: "content_users" },
    { label: "反応数", key: "analytics_events" },
    { label: "成功率", key: "success_rate", format: formatPercent },
  ]);
  const providerRows = displayRows(previewSectionRows(preview, "providerAccounts"), [
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "表示数", key: "content_events" },
    { label: "利用ユーザー", key: "users" },
    { label: "URL", key: "urls" },
    { label: "最新", key: "latest_ms", format: formatDate },
  ]);
  const userRows = displayRows(previewSectionRows(preview, "activeUsers"), [
    { label: "利用量", key: "usage_bucket" },
    { label: "ユーザー数", key: "users" },
    { label: "表示数", key: "content_events" },
    { label: "平均利用", key: "avg_events_per_user", format: (value) => formatAverage(value) },
    { label: "平均サービス数", key: "avg_providers_per_user", format: (value) => formatAverage(value) },
    { label: "最新", key: "latest_ms", format: formatDate },
  ]);
  const contentRows = displayRows(previewSectionRows(preview, "topContent"), [
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "タイトル", key: "title" },
    { label: "URL", key: "content_url", format: displayUrl },
    { label: "表示数", key: "content_events" },
    { label: "利用ユーザー", key: "users" },
  ]);
  const hourRows = displayRows(previewSectionRows(preview, "bestHours"), [
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "時間帯", key: "hour_utc", format: formatLocalHourFromUtc },
    { label: "表示数", key: "content_events" },
    { label: "利用ユーザー", key: "users" },
  ]);
  const weekdayRows = displayRows(previewSectionRows(preview, "bestWeekdays"), [
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "曜日", key: "weekday_utc", format: formatWeekday },
    { label: "表示数", key: "content_events" },
    { label: "利用ユーザー", key: "users" },
  ]);
  const funnelRows = displayRows(previewSectionRows(preview, "funnelAnalytics"), [
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "URL投稿", key: "url_posts" },
    { label: "カード表示率", key: "extract_success_rate", format: formatPercent },
    { label: "表示完了率", key: "send_success_rate", format: formatPercent },
    { label: "反応数", key: "interaction_events" },
    { label: "反応率", key: "interaction_rate", format: formatPercent },
    { label: "ユーザー", key: "users" },
  ]);
  const cohortRows = displayRows(previewSectionRows(preview, "weeklyCohorts"), [
    { label: "初回週", key: "cohort_week_ms", format: formatDate },
    { label: "反応週", key: "activity_week_ms", format: formatDate },
    { label: "経過週", key: "age_weeks" },
    { label: "対象ユーザー", key: "cohort_users" },
    { label: "継続ユーザー", key: "retained_users" },
    { label: "継続率", key: "retention_rate", format: formatPercent },
  ]);
  const lifetimeRows = displayRows(previewSectionRows(preview, "contentLifetime"), [
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "タイトル", key: "title" },
    { label: "URL", key: "content_url", format: displayUrl },
    { label: "件数", key: "content_events" },
    { label: "ユーザー", key: "users" },
    { label: "継続時間", key: "lifetime_hours", format: (value) => formatAverage(value, "h") },
  ]);
  const reuseRows = displayRows(previewSectionRows(preview, "urlReuse"), [
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "URL", key: "content_url", format: displayUrl },
    { label: "件数", key: "content_events" },
    { label: "ユーザー", key: "users" },
    { label: "サーバー", key: "guilds" },
    { label: "1日あたり拡散", key: "spread_velocity_per_day", format: (value) => formatAverage(value) },
  ]);
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">サーバー管理者向け統計プレビュー</h2>
          <p className="text-sm text-muted-foreground">
            {preview ? `${preview.scopeLabel} / ${formatDate(preview.window.startMs)} - ${formatDate(preview.window.endMs)} / ${preview.durationMs}ms` : "読み込み中"}
          </p>
        </div>
        <Badge tone="warning">管理者だけに表示中</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>プレビュー条件</CardTitle>
          <CardDescription>guild_id を指定すると、そのサーバーの管理者に見せる想定の統計になります。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 lg:grid-cols-4">
            <Input value={filters.guildId} onChange={(event) => setFilter("guildId", event.target.value)} placeholder="サーバーID" />
            <Input value={filters.providerId} onChange={(event) => setFilter("providerId", event.target.value)} placeholder="サービスID" />
            <Input value={filters.accountKey} onChange={(event) => setFilter("accountKey", event.target.value)} placeholder="アカウント" />
            <Input value={filters.contentType} onChange={(event) => setFilter("contentType", event.target.value)} placeholder="種類" />
          </div>
          <div className="grid gap-3 lg:grid-cols-[1fr_1fr_120px_120px_150px_auto]">
            <Input type="datetime-local" value={filters.dateFrom} onChange={(event) => setFilter("dateFrom", event.target.value)} />
            <Input type="datetime-local" value={filters.dateTo} onChange={(event) => setFilter("dateTo", event.target.value)} />
            <select className={controlClass} value={filters.bucket} onChange={(event) => setFilter("bucket", event.target.value)}>
              <option value="day">日別</option>
              <option value="hour">時間別</option>
            </select>
            <Input value={filters.limit} onChange={(event) => setFilter("limit", event.target.value)} inputMode="numeric" />
            <select className={controlClass} value={filters.urlVisibility} onChange={(event) => setFilter("urlVisibility", event.target.value)}>
              <option value="raw">Raw URL</option>
              <option value="normalized">Normalized URL</option>
            </select>
            <div className="flex gap-2">
              <Button type="button" onClick={() => load()} disabled={loading}>
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                表示
              </Button>
              <Button type="button" variant="outline" onClick={reset} disabled={loading}>
                <RefreshCcw size={16} />
              </Button>
            </div>
          </div>
          {error ? <div className="rounded-md border border-destructive/40 bg-card p-3 text-sm text-destructive">{error}</div> : null}
        </CardContent>
      </Card>

      <PreviewCards cards={preview?.cards || []} />

      <ReportHighlights
        title="サーバーレポート要約"
        description="サーバー管理者が先に見るべき人気、継続、表示の安定性をまとめています。"
        insights={guildInsights}
        trendRows={guildTimeSeries}
        rankingTitle="よく見られた投稿/URL"
        rankingRows={guildTopContent}
        rankingValueKey="content_events"
        rankingLabelKeys={["title", "content_url", "provider_id"]}
      />

      <div className="grid gap-3 md:grid-cols-3">
        <MetricCard label="リピートユーザー" value={retention.returning_users} />
        <MetricCard label="新規反応ユーザー" value={retention.first_seen_users} />
        <MetricCard label="リピート率" value={formatPercent(retention.returning_rate)} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>利用推移</CardTitle>
            <CardDescription>このサーバーでの表示数と利用ユーザーの推移です。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={timeRows} maxColumns={5} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>人気のサービス/アカウント</CardTitle>
            <CardDescription>サーバー内でよく反応されるアカウントです。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={providerRows} maxColumns={6} /></CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>利用ユーザー</CardTitle>
            <CardDescription>サーバー内でよく利用しているユーザーです。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={userRows} maxColumns={5} /></CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>よく見られた投稿 / URL</CardTitle>
            <CardDescription>URL と取得したタイトルなど、投稿を判断しやすい情報だけを表示します。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={contentRows} maxColumns={6} /></CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>反応されやすい時間</CardTitle>
            <CardDescription>UTC 時間帯で集計しています。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={hourRows} maxColumns={5} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>曜日傾向</CardTitle>
            <CardDescription>曜日別の表示量です。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={weekdayRows} maxColumns={5} /></CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>反応までの流れ</CardTitle>
            <CardDescription>URL投稿が表示され、反応につながるまでの流れを見ます。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={funnelRows} maxColumns={8} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>週別の継続反応</CardTitle>
            <CardDescription>初回反応した週ごとに、その後も反応しているかを確認します。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={cohortRows} maxColumns={6} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>長く見られるコンテンツ</CardTitle>
            <CardDescription>一度だけでなく、時間をまたいで反応され続けるURLを確認します。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={lifetimeRows} maxColumns={7} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>URLの再利用と広がり</CardTitle>
            <CardDescription>同じURLがどれだけ繰り返し使われ、どのくらい広がったかを見ます。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={reuseRows} maxColumns={7} /></CardContent>
        </Card>
      </div>
    </div>
  );
}

function ProviderMarketingPreviewPanel() {
  const [filters, setFilters] = useState<ProviderPreviewFilterState>(defaultProviderPreviewFilters);
  const [preview, setPreview] = useState<AdminUserFacingPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadInitial() {
      setLoading(true);
      setError(null);
      try {
        const search = buildProviderPreviewSearch(defaultProviderPreviewFilters);
        const payload = await fetchJson<AdminUserFacingPreview>(`/api/admin/provider-marketing-preview?${search.toString()}`);
        if (!cancelled) setPreview(payload);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "マーケティング分析プレビューの読み込みに失敗しました");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadInitial();
    return () => {
      cancelled = true;
    };
  }, []);

  function setFilter(key: keyof ProviderPreviewFilterState, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  async function load(nextFilters = filters) {
    setLoading(true);
    setError(null);
    try {
      const search = buildProviderPreviewSearch(nextFilters);
      setPreview(await fetchJson<AdminUserFacingPreview>(`/api/admin/provider-marketing-preview?${search.toString()}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "マーケティング分析プレビューの読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function reset() {
    setFilters(defaultProviderPreviewFilters);
    await load(defaultProviderPreviewFilters);
  }

  const retention = previewSectionRow(preview, "audienceRetention");
  const providerTimeSeries = previewSectionRows(preview, "timeSeries");
  const providerAccounts = previewSectionRows(preview, "providerAccounts");
  const providerTopContent = previewSectionRows(preview, "topContent");
  const providerSegments = previewSectionRows(preview, "providerSegments");
  const providerSummaryAnalytics = preview?.summary.analytics || {};
  const providerTopAccount = topBy(providerAccounts, "content_events");
  const providerTopContentRow = topBy(providerTopContent, "content_events");
  const providerTopSegment = topBy(providerSegments, "segment_score");
  const providerSuccessRate = maybeNumber(providerSummaryAnalytics.success_rate);
  const providerInsights: InsightItem[] = [
    {
      label: "一番見られている対象",
      value: formatEntity(providerTopAccount, ["provider_id", "account_key"]),
      body: `${formatCount(providerTopAccount?.content_events)}件、${formatCount(providerTopAccount?.guilds)}サーバーに届いています。`,
      tone: "success",
    },
    {
      label: "人気コンテンツ",
      value: formatEntity(providerTopContentRow, ["title", "content_url"]),
      body: `${formatCount(providerTopContentRow?.content_events)}件表示。どの投稿が伸びたかを先に確認できます。`,
      tone: "default",
    },
    {
      label: "強いマーケティング軸",
      value: formatEntity(providerTopSegment, ["axis_label", "facet_value", "metric_label"]),
      body: `${formatCount(providerTopSegment?.events)}件の反応があります。投稿内容・形式・流入のどれが効いているかを見る軸です。`,
      tone: "default",
    },
    {
      label: "表示の安定性",
      value: providerSuccessRate !== null ? formatPercent(providerSuccessRate) : "確認中",
      body: providerSuccessRate === null ? "表示できた割合を計算できるデータがまだありません。" : providerSuccessRate >= 0.95 ? "投稿の展開は安定しています。" : "一部の投稿で表示まで届きにくい傾向があります。",
      tone: providerSuccessRate !== null && providerSuccessRate < 0.95 ? "warning" : "success",
    },
  ];
  const accountRows = displayRows(previewSectionRows(preview, "providerAccounts"), [
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "表示数", key: "content_events" },
    { label: "利用ユーザー", key: "users" },
    { label: "サーバー", key: "guilds" },
    { label: "URL", key: "urls" },
  ]);
  const reachRows = displayRows(previewSectionRows(preview, "reachByGuild"), [
    { label: "サーバー", key: "guild_id" },
    { label: "表示数", key: "content_events" },
    { label: "利用ユーザー", key: "users" },
    { label: "URL", key: "urls" },
  ]);
  const audienceRows = displayRows(previewSectionRows(preview, "audienceUsers"), [
    { label: "利用量", key: "usage_bucket" },
    { label: "ユーザー数", key: "users" },
    { label: "表示数", key: "content_events" },
    { label: "平均利用", key: "avg_events_per_user", format: (value) => formatAverage(value) },
    { label: "平均URL", key: "avg_urls_per_user", format: (value) => formatAverage(value) },
    { label: "最新", key: "latest_ms", format: formatDate },
  ]);
  const topContentRows = displayRows(previewSectionRows(preview, "topContent"), [
    { label: "アカウント", key: "account_key" },
    { label: "タイトル", key: "title" },
    { label: "投稿者", key: "author_name" },
    { label: "URL", key: "content_url", format: displayUrl },
    { label: "表示数", key: "content_events" },
    { label: "サーバー", key: "guilds" },
  ]);
  const topicRows = displayRows(previewSectionRows(preview, "topics"), [
    { label: "分析軸", key: "facet_key" },
    { label: "値", key: "facet_value" },
    { label: "回数", key: "events" },
    { label: "利用ユーザー", key: "users" },
    { label: "サーバー", key: "guilds" },
  ]);
  const valueRows = displayRows(previewSectionRows(preview, "valueDrivers"), [
    { label: "切り口", key: "driver_type" },
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "種類", key: "content_type" },
    { label: "URL", key: "content_url", format: displayUrl },
    { label: "注目度", key: "value_score" },
    { label: "理由", key: "value_signal", format: signalLabel },
    { label: "サーバー", key: "guilds" },
  ]);
  const urlParameterRows = displayRows(previewSectionRows(preview, "urlParameters"), [
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "URLパラメータ", key: "query_key" },
    { label: "分類", key: "query_key_family", format: queryFamilyLabel },
    { label: "件数", key: "content_events" },
    { label: "サーバー", key: "guilds" },
  ]);
  const providerSegmentRows = displayRows(previewSectionRows(preview, "providerSegments"), [
    { label: "サービス", key: "provider_id" },
    { label: "軸", key: "axis_label" },
    { label: "指標", key: "metric_label" },
    { label: "値", key: "facet_value" },
    { label: "件数", key: "events" },
    { label: "ユーザー", key: "users" },
    { label: "サーバー", key: "guilds" },
    { label: "平均", key: "avg_numeric_value", format: (value) => formatAverage(value) },
    { label: "スコア", key: "segment_score" },
  ]);
  const numericRows = displayRows(previewSectionRows(preview, "numericSignals"), [
    { label: "指標", key: "facet_key" },
    { label: "回数", key: "events" },
    { label: "平均", key: "avg_value", format: (value) => formatAverage(value) },
    { label: "最大", key: "max_value", format: (value) => formatAverage(value) },
    { label: "合計", key: "sum_value", format: (value) => formatAverage(value) },
  ]);
  const contentTypeRows = displayRows(previewSectionRows(preview, "contentTypes"), [
    { label: "サービス", key: "provider_id" },
    { label: "種類", key: "content_type" },
    { label: "表示数", key: "content_events" },
    { label: "利用ユーザー", key: "users" },
    { label: "サーバー", key: "guilds" },
  ]);
  const hourRows = displayRows(previewSectionRows(preview, "bestHours"), [
    { label: "アカウント", key: "account_key" },
    { label: "時間帯", key: "hour_utc", format: formatLocalHourFromUtc },
    { label: "表示数", key: "content_events" },
    { label: "利用ユーザー", key: "users" },
    { label: "サーバー", key: "guilds" },
  ]);
  const interestRows = displayRows(previewSectionRows(preview, "audienceInterests"), [
    { label: "対象アカウント", key: "target_account_key" },
    { label: "併読サービス", key: "interest_provider_id" },
    { label: "併読アカウント", key: "interest_account_key" },
    { label: "共起数", key: "co_events" },
    { label: "共通ユーザー", key: "shared_users" },
    { label: "共通サーバー", key: "shared_guilds" },
  ]);
  const funnelRows = displayRows(previewSectionRows(preview, "funnelAnalytics"), [
    { label: "サービス", key: "provider_id" },
    { label: "アカウント", key: "account_key" },
    { label: "URL投稿", key: "url_posts" },
    { label: "カード表示率", key: "extract_success_rate", format: formatPercent },
    { label: "表示完了率", key: "send_success_rate", format: formatPercent },
    { label: "反応数", key: "interaction_events" },
    { label: "反応率", key: "interaction_rate", format: formatPercent },
    { label: "サーバー", key: "guilds" },
  ]);
  const cohortRows = displayRows(previewSectionRows(preview, "weeklyCohorts"), [
    { label: "初回週", key: "cohort_week_ms", format: formatDate },
    { label: "反応週", key: "activity_week_ms", format: formatDate },
    { label: "経過週", key: "age_weeks" },
    { label: "対象ユーザー", key: "cohort_users" },
    { label: "継続ユーザー", key: "retained_users" },
    { label: "継続率", key: "retention_rate", format: formatPercent },
  ]);
  const lifetimeRows = displayRows(previewSectionRows(preview, "contentLifetime"), [
    { label: "アカウント", key: "account_key" },
    { label: "タイトル", key: "title" },
    { label: "種類", key: "content_type" },
    { label: "URL", key: "content_url", format: displayUrl },
    { label: "件数", key: "content_events" },
    { label: "サーバー", key: "guilds" },
    { label: "継続時間", key: "lifetime_hours", format: (value) => formatAverage(value, "h") },
  ]);
  const reuseRows = displayRows(previewSectionRows(preview, "urlReuse"), [
    { label: "アカウント", key: "account_key" },
    { label: "URL", key: "content_url", format: displayUrl },
    { label: "件数", key: "content_events" },
    { label: "ユーザー", key: "users" },
    { label: "サーバー", key: "guilds" },
    { label: "1日あたり拡散", key: "spread_velocity_per_day", format: (value) => formatAverage(value) },
  ]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">プロバイダー向けマーケティング分析プレビュー</h2>
          <p className="text-sm text-muted-foreground">
            {preview ? `${preview.scopeLabel} / ${formatDate(preview.window.startMs)} - ${formatDate(preview.window.endMs)} / ${preview.durationMs}ms` : "読み込み中"}
          </p>
        </div>
        <Badge tone="warning">管理者だけに表示中</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>プレビュー条件</CardTitle>
          <CardDescription>サービスIDとアカウントを指定すると、アカウント担当者向けの見え方に近づきます。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 lg:grid-cols-5">
            <Input value={filters.providerId} onChange={(event) => setFilter("providerId", event.target.value)} placeholder="サービスID" />
            <Input value={filters.accountKey} onChange={(event) => setFilter("accountKey", event.target.value)} placeholder="アカウント" />
            <Input value={filters.guildId} onChange={(event) => setFilter("guildId", event.target.value)} placeholder="サーバーID" />
            <Input value={filters.contentType} onChange={(event) => setFilter("contentType", event.target.value)} placeholder="種類" />
            <Input value={filters.facetKey} onChange={(event) => setFilter("facetKey", event.target.value)} placeholder="分析軸" />
          </div>
          <div className="grid gap-3 lg:grid-cols-[1fr_1fr_120px_120px_150px_auto]">
            <Input type="datetime-local" value={filters.dateFrom} onChange={(event) => setFilter("dateFrom", event.target.value)} />
            <Input type="datetime-local" value={filters.dateTo} onChange={(event) => setFilter("dateTo", event.target.value)} />
            <select className={controlClass} value={filters.bucket} onChange={(event) => setFilter("bucket", event.target.value)}>
              <option value="day">日別</option>
              <option value="hour">時間別</option>
            </select>
            <Input value={filters.limit} onChange={(event) => setFilter("limit", event.target.value)} inputMode="numeric" />
            <select className={controlClass} value={filters.urlVisibility} onChange={(event) => setFilter("urlVisibility", event.target.value)}>
              <option value="raw">Raw URL</option>
              <option value="normalized">Normalized URL</option>
            </select>
            <div className="flex gap-2">
              <Button type="button" onClick={() => load()} disabled={loading}>
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                表示
              </Button>
              <Button type="button" variant="outline" onClick={reset} disabled={loading}>
                <RefreshCcw size={16} />
              </Button>
            </div>
          </div>
          {error ? <div className="rounded-md border border-destructive/40 bg-card p-3 text-sm text-destructive">{error}</div> : null}
        </CardContent>
      </Card>

      <ProviderMetricProfilePanel profile={preview?.metricProfile} />
      <ReportHighlights
        title="マーケティングレポート要約"
        description="人気コンテンツ、強い軸、継続反応を先に読み取れるようにまとめています。"
        insights={providerInsights}
        trendRows={providerTimeSeries}
        rankingTitle="反応が多いコンテンツ"
        rankingRows={providerTopContent}
        rankingValueKey="content_events"
        rankingLabelKeys={["title", "content_url", "account_key"]}
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>反応までの流れ</CardTitle>
            <CardDescription>URL投稿が表示され、反応につながるまでの流れを見ます。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={funnelRows} maxColumns={8} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>週別の継続反応</CardTitle>
            <CardDescription>初回反応した週ごとに、その後も反応しているかを確認します。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={cohortRows} maxColumns={6} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>長く見られるコンテンツ</CardTitle>
            <CardDescription>一度だけでなく、時間をまたいで反応され続けるURLを確認します。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={lifetimeRows} maxColumns={7} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>URLの再利用と広がり</CardTitle>
            <CardDescription>同じURLがどれだけ繰り返し使われ、どのくらい広がったかを見ます。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={reuseRows} maxColumns={6} /></CardContent>
        </Card>
      </div>
      <PreviewCards cards={preview?.deliveryContextCards || []} />

      <div className="grid gap-3 md:grid-cols-3">
        <MetricCard label="継続反応ユーザー" value={retention.returning_users} />
        <MetricCard label="新規反応ユーザー" value={retention.first_seen_users} />
        <MetricCard label="継続率" value={formatPercent(retention.returning_rate)} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>アカウント別パフォーマンス</CardTitle>
            <CardDescription>どのアカウントがどれだけ見られているかを確認します。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={accountRows} maxColumns={6} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>届いているサーバー</CardTitle>
            <CardDescription>どのサーバーで反応が出ているかを見ます。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={reachRows} maxColumns={4} /></CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>反応ユーザー</CardTitle>
            <CardDescription>利用量ごとに、どのユーザー層が反応しているかを確認します。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={audienceRows} maxColumns={5} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>人気コンテンツ</CardTitle>
            <CardDescription>URL と取得したタイトルなどを使ったランキングです。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={topContentRows} maxColumns={6} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>反応を伸ばしている要因</CardTitle>
            <CardDescription>サービス、アカウント、種類、URL のどれが反応量や継続利用に効いているかを並べます。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={valueRows} maxColumns={8} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>流入パラメータ</CardTitle>
            <CardDescription>キャンペーンや参照元の手がかりになるURLパラメータ名を集計します。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={urlParameterRows} maxColumns={7} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>マーケティング軸別の反応</CardTitle>
            <CardDescription>投稿形式、話題、数値レンジなど、サービスごとの意味がある軸で見ます。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={providerSegmentRows} maxColumns={9} /></CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>興味・トピック</CardTitle>
            <CardDescription>ハッシュタグ、メンション、動画指標などサービス固有の分析軸です。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={topicRows} maxColumns={5} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>数値シグナル</CardTitle>
            <CardDescription>再生数、いいね数、動画時間など数値化できる指標です。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={numericRows} maxColumns={5} /></CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>コンテンツ種類</CardTitle>
            <CardDescription>動画、投稿、画像などの傾向です。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={contentTypeRows} maxColumns={5} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>反応されやすい時間</CardTitle>
            <CardDescription>UTC 時間帯の分布です。</CardDescription>
          </CardHeader>
          <CardContent><DataTable rows={hourRows} maxColumns={5} /></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>併読・興味の近さ</CardTitle>
          <CardDescription>同じユーザーがあわせて反応している provider/account を表示します。</CardDescription>
        </CardHeader>
        <CardContent><DataTable rows={interestRows} maxColumns={6} /></CardContent>
      </Card>
    </div>
  );
}

function LogsPanel({ logs, setLogs }: { logs: AdminLogs; setLogs: (logs: AdminLogs) => void }) {
  const [guildId, setGuildId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [action, setAction] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const search = new URLSearchParams();
      if (guildId.trim()) search.set("guild_id", guildId.trim());
      if (providerId.trim()) search.set("provider_id", providerId.trim());
      if (action.trim()) search.set("action", action.trim());
      search.set("limit", String(logs.limit || 100));
      setLogs(await fetchJson<AdminLogs>(`/api/admin/logs?${search.toString()}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "ログ取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-[1fr_1fr_1fr_auto]">
        <Input value={guildId} onChange={(event) => setGuildId(event.target.value)} placeholder="guild_id" />
        <Input value={providerId} onChange={(event) => setProviderId(event.target.value)} placeholder="provider_id" />
        <Input value={action} onChange={(event) => setAction(event.target.value)} placeholder="action" />
        <Button type="button" onClick={refresh} disabled={loading}>
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
          検索
        </Button>
      </div>
      {error ? <div className="rounded-md border border-destructive/40 bg-card p-3 text-sm text-destructive">{error}</div> : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>監査ログ</CardTitle>
            <CardDescription>{logs.auditLogs.length} 件</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {logs.auditLogs.map((log) => (
              <div key={log.auditLogId} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{formatCell(log.action)}</Badge>
                  {log.providerId ? <Badge tone="muted">{formatCell(log.providerId)}</Badge> : null}
                  {log.settingKey ? <Badge tone="muted">{formatCell(log.settingKey)}</Badge> : null}
                </div>
                <div className="mt-2 text-muted-foreground">{formatDate(log.createdAt)} / {formatCell(log.actorUsernameSnapshot || log.actorUserId)}</div>
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  <pre className="max-h-44 overflow-auto rounded-md bg-muted p-2 text-xs">{pretty(log.before)}</pre>
                  <pre className="max-h-44 overflow-auto rounded-md bg-muted p-2 text-xs">{pretty(log.after)}</pre>
                </div>
              </div>
            ))}
            {!logs.auditLogs.length ? <div className="text-sm text-muted-foreground">監査ログなし</div> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Bot エラー</CardTitle>
            <CardDescription>{logs.errorEvents.length} 件</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={logs.errorEvents} maxColumns={9} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function DatabasePanel({ database, setDatabase }: { database: AdminDatabase; setDatabase: (database: AdminDatabase) => void }) {
  const [table, setTable] = useState(database.selectedTable);
  const [limit, setLimit] = useState(String(database.limit || 50));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const search = new URLSearchParams({ table, limit });
      setDatabase(await fetchJson<AdminDatabase>(`/api/admin/database?${search.toString()}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "DB 読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-[minmax(220px,1fr)_120px_auto]">
        <select className={controlClass} value={table} onChange={(event) => setTable(event.target.value)}>
          {database.tables.map((item) => (
            <option key={item.name} value={item.name}>{item.label}</option>
          ))}
        </select>
        <Input value={limit} onChange={(event) => setLimit(event.target.value)} inputMode="numeric" />
        <Button type="button" onClick={load} disabled={loading}>
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Database size={16} />}
          表示
        </Button>
      </div>
      {error ? <div className="rounded-md border border-destructive/40 bg-card p-3 text-sm text-destructive">{error}</div> : null}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>{database.summary.label}</CardTitle>
              <CardDescription>{database.selectedTable} / {formatCount(database.summary.count)} rows</CardDescription>
            </div>
            <Badge tone={database.summary.available ? "success" : "warning"}>{database.summary.available ? "available" : "unavailable"}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {database.columns.map((column, index) => (
              <Badge key={String(column.Field || index)} tone="muted">{formatCell(column.Field || column.field)}</Badge>
            ))}
          </div>
          <DataTable rows={database.rows} maxColumns={10} />
        </CardContent>
      </Card>
    </div>
  );
}

function SupportPanel({ catalog }: { catalog: CatalogProvider[] }) {
  const defaultProvider = catalog[0]?.providerId || "twitter";
  const [guildId, setGuildId] = useState("");
  const [providerId, setProviderId] = useState(defaultProvider);
  const [settingKey, setSettingKey] = useState("");
  const [valueText, setValueText] = useState("true");
  const [changesText, setChangesText] = useState("");
  const [settings, setSettings] = useState<SupportSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const provider = useMemo(() => catalog.find((item) => item.providerId === providerId) || catalog[0], [catalog, providerId]);
  const settingOptions = settings?.specs.length ? settings.specs : provider?.settings || [];

  useEffect(() => {
    if (!settingOptions.length) return;
    if (!settingOptions.some((item) => item.key === settingKey)) setSettingKey(settingOptions[0].key);
  }, [settingKey, settingOptions]);

  function fillValue(key: string) {
    const state = settings?.settings.find((item) => item.key === key);
    if (state) setValueText(pretty(state.value));
  }

  async function loadSettings() {
    setLoading(true);
    setMessage(null);
    setError(null);
    try {
      const search = new URLSearchParams({ guild_id: guildId.trim(), provider_id: providerId });
      const payload = await fetchJson<SupportSettings>(`/api/admin/settings?${search.toString()}`);
      setSettings(payload);
      const firstKey = payload.specs[0]?.key || "";
      setSettingKey(firstKey);
      const firstState = payload.settings.find((item) => item.key === firstKey);
      if (firstState) setValueText(pretty(firstState.value));
    } catch (err) {
      setError(err instanceof Error ? err.message : "設定取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function saveSettings() {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        guildId: guildId.trim(),
        providerId,
      };
      const parsedChanges = changesText.trim() ? parseJsonLoose(changesText) : null;
      if (parsedChanges && typeof parsedChanges === "object" && !Array.isArray(parsedChanges)) {
        body.changes = parsedChanges;
      } else if (changesText.trim()) {
        throw new Error("changes JSON must be an object.");
      } else {
        body.settingKey = settingKey;
        body.value = parseJsonLoose(valueText);
      }

      const result = await fetchJson<Row>("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      await loadSettings();
      setMessage(`保存しました: ${formatCell(result.changedKeys)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>サーバー指定設定変更</CardTitle>
          <CardDescription>guild_id と provider_id を指定してサポート対応します</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 lg:grid-cols-[1fr_220px_auto]">
            <Input value={guildId} onChange={(event) => setGuildId(event.target.value)} placeholder="guild_id" />
            <select className={controlClass} value={providerId} onChange={(event) => setProviderId(event.target.value)}>
              {catalog.map((item) => (
                <option key={item.providerId} value={item.providerId}>{item.label}</option>
              ))}
            </select>
            <Button type="button" variant="outline" onClick={loadSettings} disabled={loading}>
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
              読込
            </Button>
          </div>

          <div className="grid gap-3 lg:grid-cols-[260px_1fr]">
            <select
              className={controlClass}
              value={settingKey}
              onChange={(event) => {
                setSettingKey(event.target.value);
                fillValue(event.target.value);
              }}
            >
              {settingOptions.map((item) => (
                <option key={item.key} value={item.key}>{item.key}</option>
              ))}
            </select>
            <Textarea value={valueText} onChange={(event) => setValueText(event.target.value)} className="min-h-20 font-mono" />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">changes JSON</label>
            <Textarea
              value={changesText}
              onChange={(event) => setChangesText(event.target.value)}
              placeholder={'{"enabled": true}'}
              className="min-h-24 font-mono"
            />
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button type="button" onClick={saveSettings} disabled={saving}>
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              保存
            </Button>
            {message ? <span className="text-sm text-green-700">{message}</span> : null}
            {error ? <span className="text-sm text-destructive">{error}</span> : null}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{settings ? `${settings.providerLabel} 現在値` : "現在値"}</CardTitle>
            <CardDescription>{settings ? `${settings.guildId} / ${settings.providerId}` : "未読込"}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {(settings?.settings || []).map((item) => (
              <button
                key={item.key}
                type="button"
                className="block w-full rounded-md border p-3 text-left text-sm transition hover:bg-muted"
                onClick={() => {
                  setSettingKey(item.key);
                  setValueText(pretty(item.value));
                }}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{item.key}</span>
                  {item.changedFromDefault ? <Badge tone="warning">changed</Badge> : <Badge tone="muted">default</Badge>}
                </div>
                <pre className="mt-2 max-h-24 overflow-auto rounded-md bg-muted p-2 text-xs">{pretty(item.value)}</pre>
              </button>
            ))}
            {!settings ? <div className="text-sm text-muted-foreground">guild_id を指定して読込</div> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>設定仕様</CardTitle>
            <CardDescription>{provider?.label || providerId}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable rows={(settingOptions || []) as unknown as Row[]} maxColumns={5} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function AdminConsole({
  user,
  initialOverview,
  initialLogs,
  initialDatabase,
  catalog,
}: {
  user: DashboardUser;
  initialOverview: AdminOverview;
  initialLogs: AdminLogs;
  initialDatabase: AdminDatabase;
  catalog: CatalogProvider[];
}) {
  const [tab, setTab] = useState<AdminTab>("overview");
  const [overview, setOverview] = useState(initialOverview);
  const [logs, setLogs] = useState(initialLogs);
  const [database, setDatabase] = useState(initialDatabase);
  const [refreshingOverview, setRefreshingOverview] = useState(false);

  async function refreshOverview() {
    setRefreshingOverview(true);
    try {
      setOverview(await fetchJson<AdminOverview>("/api/admin/overview"));
    } finally {
      setRefreshingOverview(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <ShieldCheck size={20} />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold">Admin Console</h1>
              <p className="truncate text-xs text-muted-foreground">{user.globalName || user.username || user.id}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard?mode=user">ユーザー画面</Link>
            </Button>
            <SignOutButton locale="ja" />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-4 px-3 py-4 sm:px-4 sm:py-5">
        <nav className="grid gap-2 sm:grid-cols-3 lg:grid-cols-7">
          {tabs.map((item) => {
            const Icon = item.icon;
            const active = tab === item.value;
            return (
              <button
                key={item.value}
                type="button"
                className={cn(
                  "flex min-h-11 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition",
                  active ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted",
                )}
                onClick={() => setTab(item.value)}
              >
                <Icon size={16} />
                {item.label}
              </button>
            );
          })}
        </nav>

        {tab === "overview" ? <OverviewPanel overview={overview} onRefresh={refreshOverview} refreshing={refreshingOverview} /> : null}
        {tab === "analytics" ? <DetailedAnalyticsPanel /> : null}
        {tab === "guildPreview" ? <GuildAdminPreviewPanel /> : null}
        {tab === "providerPreview" ? <ProviderMarketingPreviewPanel /> : null}
        {tab === "logs" ? <LogsPanel logs={logs} setLogs={setLogs} /> : null}
        {tab === "database" ? <DatabasePanel database={database} setDatabase={setDatabase} /> : null}
        {tab === "support" ? <SupportPanel catalog={catalog} /> : null}
      </main>
    </div>
  );
}
