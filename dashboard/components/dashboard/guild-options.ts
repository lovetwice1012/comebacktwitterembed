export type GuildOption = {
  guildId: string;
  name: string;
  iconUrl?: string | null;
  canEdit?: boolean;
  canManageGuild?: boolean;
};

let guildOptionsPromise: Promise<GuildOption[]> | null = null;

export function uniqueGuildIds(ids: string[]) {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

export function guildSelectionTargetPath(ids: string[]) {
  const selected = uniqueGuildIds(ids);
  if (selected.length === 0) return "/dashboard";
  if (selected.length === 1) return `/dashboard/${selected[0]}/settings`;
  return `/dashboard/bulk?guildIds=${encodeURIComponent(selected.join(","))}`;
}

export function parseGuildSelectionFromPath(pathname = window.location.pathname, search = window.location.search) {
  if (pathname === "/dashboard") return [];
  if (pathname === "/dashboard/bulk") {
    const params = new URLSearchParams(search);
    return uniqueGuildIds((params.get("guildIds") || "").split(","));
  }
  const match = pathname.match(/^\/dashboard\/(\d{5,32})(?:\/|$)/);
  return match ? [match[1]] : [];
}

export function pushGuildSelection(ids: string[]) {
  const guildIds = uniqueGuildIds(ids);
  window.history.pushState({ guildIds }, "", guildSelectionTargetPath(guildIds));
  window.dispatchEvent(new CustomEvent("dashboard:guild-selection-change", { detail: { guildIds } }));
}

export async function loadGuildOptions() {
  guildOptionsPromise ??= fetch("/api/guilds/switcher", {
    headers: { Accept: "application/json" },
  }).then(async (res) => {
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error || "Failed to load servers.");
    return json as GuildOption[];
  });
  return guildOptionsPromise;
}
