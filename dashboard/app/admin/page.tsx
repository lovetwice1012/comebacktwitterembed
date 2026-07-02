import { notFound } from "next/navigation";
import { AdminConsole } from "@/components/admin/admin-console";
import { getAdminDatabaseTable, getAdminLogs, getAdminOverview, getAdminProviderCatalog } from "@/lib/admin-data";
import { getDashboardLocale } from "@/lib/server-locale";
import { requireDashboardSession } from "@/lib/server-session";

export default async function AdminPage() {
  const locale = await getDashboardLocale();
  const session = await requireDashboardSession();
  if (!session.user.isAdmin) notFound();

  const [overview, logs, database, catalog] = await Promise.all([
    getAdminOverview(),
    getAdminLogs({ limit: 80 }),
    getAdminDatabaseTable("guild_provider_settings", 50),
    getAdminProviderCatalog(locale),
  ]);

  return (
    <AdminConsole
      user={session.user}
      initialOverview={overview}
      initialLogs={logs}
      initialDatabase={database}
      catalog={catalog}
    />
  );
}
