import { usesNewDashboardUI } from "@/lib/ui-rollout";
import LegacyPage from "@/legacy/pages/admin";
import { notFound } from "next/navigation";
import { AdminConsoleLoader } from "@/components/admin/admin-console-loader";
import { requireDashboardSession } from "@/lib/server-session";

export default async function AdminPage() {
  const session = await requireDashboardSession();
  if (!session.user.isAdmin) notFound();
  if (!await usesNewDashboardUI(session)) return <LegacyPage  />;

  return <AdminConsoleLoader user={session.user} />;
}
