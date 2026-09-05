export async function register() {
  // The independent report worker owns complete report generation when connected.
  if (process.env.ADMIN_AGENT_TOKEN) return;
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const {
      warmAdminDetailedAnalyticsCache,
      warmAdminGuildAnalyticsPreviewCache,
      warmAdminOverviewCache,
      warmAdminProviderMarketingPreviewCache,
    } = await import("./lib/admin-data");
    warmAdminOverviewCache();
    // These reports are low-priority work.  The bounded build scheduler lets
    // the operational overview finish first instead of serializing all pages.
    warmAdminDetailedAnalyticsCache();
    warmAdminGuildAnalyticsPreviewCache();
    warmAdminProviderMarketingPreviewCache();
  }
}
