"use client";

import dynamic from "next/dynamic";
import { ShieldCheck } from "lucide-react";
import type { DashboardUser } from "@/lib/types";

const AdminConsole = dynamic(
  () => import("@/components/admin/admin-console").then((mod) => mod.AdminConsole),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center gap-3 px-3 py-3 sm:px-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <ShieldCheck size={20} />
            </div>
            <div>
              <h1 className="text-lg font-semibold">Admin Console</h1>
              <p className="text-xs text-muted-foreground">Loading console...</p>
            </div>
          </div>
        </header>
      </div>
    ),
  },
);

export function AdminConsoleLoader({ user }: { user: DashboardUser }) {
  return <AdminConsole user={user} />;
}
