import { notFound } from "next/navigation";
import { AdminConsoleLoader } from "@/components/admin/admin-console-loader";
import { getDashboardLocale } from "@/lib/server-locale";
import { requireDashboardSession } from "@/lib/server-session";

export default async function AdminPage() {
  const locale = await getDashboardLocale();
  const session = await requireDashboardSession();
  if (!session.user.isAdmin) notFound();

  return (
    <AdminConsoleLoader
      user={session.user}
    />
  );
}
