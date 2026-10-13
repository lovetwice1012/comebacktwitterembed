import { usesNewDashboardUI } from "@/lib/ui-rollout";
import LegacyPage from "@/legacy/pages/admin-url-inspector";
import { notFound } from "next/navigation";
import { requireDashboardSession } from "@/lib/server-session";
import { AdminConsoleLoader } from "@/components/admin/admin-console-loader";

export default async function UrlInspectorPage() {
  const session = await requireDashboardSession();
  if (!session.user.isAdmin) notFound();
  if (!await usesNewDashboardUI(session)) return <LegacyPage  />;
  return <AdminConsoleLoader user={session.user} />;
}
