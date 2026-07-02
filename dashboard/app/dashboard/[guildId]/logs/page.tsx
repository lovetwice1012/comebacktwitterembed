import { AuditLogsPage } from "@/features/audit/audit-logs-page";

type Params = { params: Promise<{ guildId: string }> };

export default async function LogsPage({ params }: Params) {
  const { guildId } = await params;
  return <AuditLogsPage guildId={guildId} />;
}
