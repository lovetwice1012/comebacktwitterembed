"use client";

import { ChevronDown, LockKeyhole } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import {
  type GuildOption,
  loadGuildOptions,
  pushGuildSelection,
  uniqueGuildIds,
} from "@/components/dashboard/guild-options";
import { type DashboardLocale, createTranslator } from "@/lib/i18n";
import { cn } from "@/lib/utils";
const emptyGuilds: GuildOption[] = [];

export function GuildSwitcher({
  selectedGuildIds,
  guilds = emptyGuilds,
  locale,
}: {
  selectedGuildIds: string[];
  guilds?: GuildOption[];
  locale: DashboardLocale;
}) {
  const t = createTranslator(locale);
  const router = useRouter();
  const panelId = useId(), triggerRef = useRef<HTMLButtonElement>(null), containerRef = useRef<HTMLDivElement>(null);
  const [navigating, startNavigation] = useTransition();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(uniqueGuildIds(selectedGuildIds));
  const [bulkMode, setBulkMode] = useState(selectedGuildIds.length > 1);
  const [options, setOptions] = useState<GuildOption[]>(guilds);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(guilds.length > 1);
  const [loadError, setLoadError] = useState<string | null>(null);
  const guildById = useMemo(() => new Map(options.map((guild) => [guild.guildId, guild])), [options]);

  async function ensureOptionsLoaded() {
    if (loaded) return;
    setLoading(true);
    setLoadError(null);
    try {
      const loaded = await loadGuildOptions();
      const merged = new Map([...options, ...loaded].map((guild) => [guild.guildId, guild]));
      setOptions([...merged.values()]);
      setLoaded(true);
    } catch {
      setLoadError(t("shell.guildSwitcher.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSelected(uniqueGuildIds(selectedGuildIds));
    setBulkMode(selectedGuildIds.length > 1);
  }, [selectedGuildIds]);

  useEffect(() => {
    setOptions((current) => {
      const merged = new Map([...current, ...guilds].map((guild) => [guild.guildId, guild]));
      return [...merged.values()];
    });
  }, [guilds]);

  useEffect(() => {
    if (!open) return;
    containerRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    const close = (event: PointerEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return;
      setOpen(false); setSelected(uniqueGuildIds(selectedGuildIds));
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); setOpen(false); setSelected(uniqueGuildIds(selectedGuildIds)); triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open, selectedGuildIds]);

  const committedIds = uniqueGuildIds(selectedGuildIds);
  const label =
    committedIds.length === 0
      ? t("shell.guildSwitcher.empty")
      : committedIds.length === 1
        ? guildById.get(committedIds[0])?.name || committedIds[0]
        : t("shell.guildSwitcher.count", { count: committedIds.length });

  const visibleOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...options].sort((a, b) => Number(selected.includes(b.guildId)) - Number(selected.includes(a.guildId)) || a.name.localeCompare(b.name));
    const filtered = q ? sorted.filter((guild) => guild.name.toLowerCase().includes(q) || guild.guildId.includes(q)) : sorted;
    return filtered.slice(0, 80);
  }, [options, query, selected]);

  function apply(nextIds: string[]) {
    const next = uniqueGuildIds(nextIds);
    setSelected(next);
  }

  function openSelection() {
    setOpen(false);
    startNavigation(() => pushGuildSelection(selected, href => router.push(href)));
  }

  return (
    <div ref={containerRef} className="relative min-w-0 flex-1 sm:flex-none">
      <button
        ref={triggerRef}
        type="button"
        disabled={navigating}
        className="flex min-h-11 w-full min-w-0 max-w-none items-center gap-2 rounded-md border bg-card px-2 text-left text-sm transition hover:bg-muted sm:max-w-[240px] md:max-w-[320px]"
        onClick={() => {
          if (open) { setOpen(false); setSelected(uniqueGuildIds(selectedGuildIds)); }
          else { setOpen(true); void ensureOptionsLoaded(); }
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
      >
        {committedIds.length ? <span className="hidden shrink-0 text-muted-foreground sm:inline">{t("shell.guildSwitcher.label")}</span> : null}
        <span className={cn("min-w-0 flex-1 truncate", committedIds.length === 0 && "text-muted-foreground")}>{label}</span>
        <ChevronDown size={15} className="shrink-0 text-muted-foreground" />
      </button>
      {open ? (
        <div id={panelId} role="dialog" aria-label={t("shell.guildSwitcher.label")} className="absolute left-0 top-12 z-50 w-[min(360px,calc(100vw-1.5rem))] rounded-md border bg-card p-2 shadow-soft sm:left-auto sm:right-0 sm:w-[min(360px,calc(100vw-2rem))]">
          <div className="mb-2 flex gap-1 rounded-md bg-muted p-1">
            <button type="button" className={cn("min-h-10 flex-1 rounded px-2 text-sm", !bulkMode && "bg-card shadow-sm")} aria-pressed={!bulkMode} onClick={() => { setBulkMode(false); setSelected(current => current.slice(0, 1)); }}>{locale === "ja" ? "サーバーを切り替える" : "Switch server"}</button>
            <button type="button" className={cn("min-h-10 flex-1 rounded px-2 text-sm", bulkMode && "bg-card shadow-sm")} aria-pressed={bulkMode} onClick={() => setBulkMode(true)}>{locale === "ja" ? "複数サーバーを変更" : "Edit multiple servers"}</button>
          </div>
          <Input
            type="search"
            className="mb-2 min-h-11"
            aria-label={t("shell.guildSwitcher.searchPlaceholder")}
            placeholder={t("shell.guildSwitcher.searchPlaceholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="max-h-80 overflow-auto">
            {visibleOptions.map((guild) => {
              const checked = selected.includes(guild.guildId);
              return (
                <label key={guild.guildId} className="flex min-h-11 cursor-pointer items-center gap-2 rounded px-2 py-2 text-sm hover:bg-muted">
                  <input
                    type={bulkMode ? "checkbox" : "radio"}
                    name={bulkMode ? undefined : panelId}
                    disabled={bulkMode && guild.canManageGuild === false && !checked}
                    checked={checked}
                    onChange={(event) => {
                      if (!bulkMode) apply([guild.guildId]);
                      else if (event.target.checked) apply([...selected, guild.guildId]);
                      else apply(selected.filter((id) => id !== guild.guildId));
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate">{guild.name}</span>
                  {bulkMode && guild.canManageGuild === false ? <span className="flex items-center gap-1 text-[10px] text-muted-foreground"><LockKeyhole size={12} aria-hidden />{locale === "ja" ? "管理権限が必要" : "Manage Server required"}</span> : null}
                </label>
              );
            })}
            {loading ? <div className="px-2 py-3 text-sm text-muted-foreground">{t("shell.guildSwitcher.loading")}</div> : null}
            {loadError ? <div className="space-y-2 px-2 py-3"><p role="alert" className="text-sm text-destructive">{loadError}</p><button type="button" className="min-h-11 rounded border px-3 text-sm" onClick={() => void ensureOptionsLoaded()}>{locale === "ja" ? "一覧を再読み込み" : "Reload servers"}</button></div> : null}
            {!loading && !loadError && visibleOptions.length === 0 ? <div className="space-y-2 px-2 py-3"><p className="text-sm text-muted-foreground">{t("shell.guildSwitcher.noResults")}</p>{query ? <button type="button" className="min-h-11 rounded border px-3 text-sm" onClick={() => setQuery("")}>{locale === "ja" ? "検索をクリア" : "Clear search"}</button> : null}</div> : null}
          </div>
          {!query.trim() && options.length > visibleOptions.length ? (
            <div className="mt-2 px-2 text-xs text-muted-foreground">{t("shell.guildSwitcher.shown", { shown: visibleOptions.length, total: options.length })}</div>
          ) : null}
          {selected.length > 0 ? (
            <button type="button" className="mt-2 min-h-11 w-full rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-muted" onClick={() => apply([])}>
              {t("shell.guildSwitcher.clear")}
            </button>
          ) : null}
          <button type="button" className="mt-2 min-h-11 w-full rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={navigating || bulkMode && selected.length < 2} onClick={openSelection}>{bulkMode ? locale === "ja" ? `選択した${selected.length}サーバーの設定を開く` : `Open settings for ${selected.length} servers` : selected.length === 1 ? locale === "ja" ? "サーバーを開く" : "Open server" : locale === "ja" ? "サーバー一覧を開く" : "Open server list"}</button>
        </div>
      ) : null}
    </div>
  );
}
