// Browser preview only. These fixed values replace server-owned session and
// locale modules while the actual route components and Dashboard shell render.
export async function requireDashboardSession() { return { user: { id: "222222222222222222", isAdmin: false } }; }
export async function getDashboardLocale() { return new URLSearchParams(window.location.search).get("locale") === "en" ? "en" as const : "ja" as const; }
export async function usesNewDashboardUI() { return true; }
