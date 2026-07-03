import { notFound } from "next/navigation";
import { AdminConsole } from "@/components/admin/admin-console";
import { getAdminProviderCatalog } from "@/lib/admin-data";
import { getDashboardLocale } from "@/lib/server-locale";
import { requireDashboardSession } from "@/lib/server-session";

export default async function AdminPage() {
  const locale = await getDashboardLocale();
  const session = await requireDashboardSession();
  if (!session.user.isAdmin) notFound();

  const catalog = await getAdminProviderCatalog(locale);

  return (
    <AdminConsole
      user={session.user}
      catalog={catalog}
    />
  );
}
