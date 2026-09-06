export async function register() {
  if (process.env.ADMIN_AGENT_TOKEN) return;
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { warmAdminOverviewCache } = await import("./lib/admin-data");
    warmAdminOverviewCache();
  }
}
