export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { warmAdminOverviewCache } = await import("./lib/admin-data");
    warmAdminOverviewCache();
  }
}
