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
  if (selected.length === 0) return "/dashboard?mode=user";
  if (selected.length === 1) return `/dashboard/${selected[0]}`;
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

export function pushGuildSelection(ids: string[], navigate?: (href: string) => void) {
  const guildIds = uniqueGuildIds(ids);
  const href = guildSelectionTargetPath(guildIds);
  if (navigate) { navigate(href); return; }
  // The workspace uses the Next router so its server-rendered shell, permissions,
  // and links are fetched for the selected server together.
  const event = new window.CustomEvent("dashboard:guild-navigation", { detail: { href }, cancelable: true });
  if (window.dispatchEvent(event)) window.location.assign(href);
}

export async function loadGuildOptions() {
  guildOptionsPromise ??= fetch("/api/guilds/switcher", {
    headers: { Accept: "application/json" },
  }).then(async (res) => {
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error || "Failed to load servers.");
    return json as GuildOption[];
  }).catch(error => {
    guildOptionsPromise = null;
    throw error;
  });
  return guildOptionsPromise;
}
