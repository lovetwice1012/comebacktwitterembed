"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  type GuildOption,
  loadGuildOptions,
  parseGuildSelectionFromPath,
  pushGuildSelection,
  uniqueGuildIds,
} from "@/components/dashboard/guild-options";
import { type DashboardLocale, createTranslator } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function GuildSwitcher({
  selectedGuildIds,
  guilds = [],
  locale,
}: {
  selectedGuildIds: string[];
  guilds?: GuildOption[];
  locale: DashboardLocale;
}) {
  const t = createTranslator(locale);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(uniqueGuildIds(selectedGuildIds));
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
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("shell.guildSwitcher.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSelected(uniqueGuildIds(selectedGuildIds));
  }, [selectedGuildIds]);

  useEffect(() => {
    setOptions((current) => {
      const merged = new Map([...current, ...guilds].map((guild) => [guild.guildId, guild]));
      return [...merged.values()];
    });
  }, [guilds]);

  useEffect(() => {
    const handler = () => {
      const guildIds = parseGuildSelectionFromPath();
      setSelected(guildIds);
      window.dispatchEvent(new CustomEvent("dashboard:guild-selection-change", { detail: { guildIds } }));
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const label =
    selected.length === 0
      ? t("shell.guildSwitcher.empty")
      : selected.length === 1
        ? guildById.get(selected[0])?.name || selected[0]
        : t("shell.guildSwitcher.count", { count: selected.length });

  const visibleOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...options].sort((a, b) => Number(selected.includes(b.guildId)) - Number(selected.includes(a.guildId)) || a.name.localeCompare(b.name));
    const filtered = q ? sorted.filter((guild) => guild.name.toLowerCase().includes(q) || guild.guildId.includes(q)) : sorted;
    return filtered.slice(0, 80);
  }, [options, query, selected]);

  function apply(nextIds: string[]) {
    const next = uniqueGuildIds(nextIds);
    setSelected(next);
    pushGuildSelection(next);
  }

  return (
    <div className="relative min-w-0 flex-1 sm:flex-none">
      <button
        type="button"
        className="flex h-9 w-full min-w-0 max-w-none items-center gap-2 rounded-md border bg-card px-2 text-left text-sm transition hover:bg-muted sm:max-w-[240px] md:max-w-[320px]"
        onClick={() => {
          setOpen((value) => !value);
          if (!open) void ensureOptionsLoaded();
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="hidden shrink-0 text-muted-foreground sm:inline">{t("shell.guildSwitcher.label")}</span>
        <span className={cn("min-w-0 flex-1 truncate", selected.length === 0 && "text-muted-foreground")}>{label}</span>
        <ChevronDown size={15} className="shrink-0 text-muted-foreground" />
      </button>
      {open ? (
        <div className="absolute left-0 top-11 z-50 w-[min(360px,calc(100vw-1.5rem))] rounded-md border bg-card p-2 shadow-soft sm:left-auto sm:right-0 sm:w-[min(360px,calc(100vw-2rem))]">
          <div className="mb-2 text-xs text-muted-foreground">{t("shell.guildSwitcher.help")}</div>
          <Input
            className="mb-2 h-9"
            placeholder={t("shell.guildSwitcher.searchPlaceholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="max-h-80 overflow-auto">
            {visibleOptions.map((guild) => {
              const checked = selected.includes(guild.guildId);
              return (
                <label key={guild.guildId} className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-sm hover:bg-muted">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      if (event.target.checked) apply([...selected, guild.guildId]);
                      else apply(selected.filter((id) => id !== guild.guildId));
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate">{guild.name}</span>
                </label>
              );
            })}
            {loading ? <div className="px-2 py-3 text-sm text-muted-foreground">{t("shell.guildSwitcher.loading")}</div> : null}
            {loadError ? <div className="px-2 py-3 text-sm text-destructive">{loadError}</div> : null}
            {!loading && !loadError && visibleOptions.length === 0 ? <div className="px-2 py-3 text-sm text-muted-foreground">{t("shell.guildSwitcher.noResults")}</div> : null}
          </div>
          {options.length > visibleOptions.length ? (
            <div className="mt-2 px-2 text-xs text-muted-foreground">{t("shell.guildSwitcher.shown", { shown: visibleOptions.length, total: options.length })}</div>
          ) : null}
          {selected.length > 0 ? (
            <button type="button" className="mt-2 w-full rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-muted" onClick={() => apply([])}>
              {t("shell.guildSwitcher.clear")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
