import { redirect } from "next/navigation";

type Params = { params: Promise<{ guildId: string }> };

export default async function AuditLogsAliasPage({ params }: Params) {
  const { guildId } = await params;
  redirect(`/dashboard/${guildId}/logs`);
}
