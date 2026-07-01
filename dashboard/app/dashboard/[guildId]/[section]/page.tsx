import { notFound } from "next/navigation";
import { AuditLogsPage } from "@/features/audit/audit-logs-page";

type Params = { params: Promise<{ guildId: string; section: string }> };

export default async function DashboardSectionFallbackPage({ params }: Params) {
  const { guildId, section } = await params;
  if (section === "logs" || section === "audit-logs") {
    return <AuditLogsPage guildId={guildId} />;
  }
  notFound();
}
