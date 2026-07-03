export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const {
      warmAdminDetailedAnalyticsCache,
      warmAdminGuildAnalyticsPreviewCache,
      warmAdminOverviewCache,
      warmAdminProviderMarketingPreviewCache,
    } = await import("./lib/admin-data");
    warmAdminOverviewCache();
    warmAdminDetailedAnalyticsCache();
    warmAdminGuildAnalyticsPreviewCache();
    warmAdminProviderMarketingPreviewCache();
  }
}
