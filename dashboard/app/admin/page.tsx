import { notFound } from "next/navigation";
import Link from "next/link";
import { AdminConsoleLoader } from "@/components/admin/admin-console-loader";
import { requireDashboardSession } from "@/lib/server-session";

export default async function AdminPage() {
  const session = await requireDashboardSession();
  if (!session.user.isAdmin) notFound();

  return (
    <>
      <div className="px-6 pt-4">
        <Link href="/admin/auto-watch-intervals" className="text-sm text-primary underline">利用者ごとの新着自動展開間隔</Link>
      </div>
      <AdminConsoleLoader user={session.user} />
    </>
  );
}
