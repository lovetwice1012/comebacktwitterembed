export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { warmAdminDetailedAnalyticsCache, warmAdminOverviewCache } = await import("./lib/admin-data");
    warmAdminOverviewCache();
    warmAdminDetailedAnalyticsCache();
  }
}
