import { notFound } from "next/navigation";
import { AdminConsoleLoader } from "@/components/admin/admin-console-loader";
import { requireDashboardSession } from "@/lib/server-session";

export default async function AdminPage() {
  const session = await requireDashboardSession();
  if (!session.user.isAdmin) notFound();

  return (
    <AdminConsoleLoader
      user={session.user}
    />
  );
}
