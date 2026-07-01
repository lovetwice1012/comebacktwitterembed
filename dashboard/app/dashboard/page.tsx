import { GuildList } from "@/components/dashboard/guild-list";
import { SignOutButton } from "@/components/dashboard/auth-buttons";
import { listVisibleGuilds } from "@/lib/discord";
import { requireDashboardSession } from "@/lib/server-session";

export default async function DashboardPage() {
  const session = await requireDashboardSession();
  const guilds = await listVisibleGuilds(session);

  return (
    <main className="mx-auto min-h-screen max-w-7xl space-y-6 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">管理可能サーバー</h1>
          <p className="text-sm text-muted-foreground">{session.user.globalName || session.user.username} としてログイン中</p>
        </div>
        <SignOutButton />
      </header>
      <GuildList guilds={guilds} />
    </main>
  );
}
