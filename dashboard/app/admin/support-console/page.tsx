import { notFound } from "next/navigation";
import { requireDashboardSession } from "@/lib/server-session";
import { ManagementConsole } from "@/components/admin/management-console";

export default async function SupportConsolePage() {
  const session = await requireDashboardSession();
  if (!session.user.isAdmin) notFound();
  return <ManagementConsole standalone />;
}
