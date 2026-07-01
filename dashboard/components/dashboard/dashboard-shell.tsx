import Link from "next/link";
import { Activity, ClipboardList, FileClock, Gauge, Layers3, Search, Server, Video } from "lucide-react";
import { SignOutButton } from "@/components/dashboard/auth-buttons";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "", label: "概要", icon: Gauge },
  { href: "providers", label: "Providers", icon: Layers3 },
  { href: "settings", label: "横断検索", icon: Search },
  { href: "preview", label: "プレビュー", icon: ClipboardList },
  { href: "diagnostics", label: "診断", icon: Activity },
  { href: "media", label: "Media", icon: Video },
  { href: "logs", label: "監査ログ", icon: FileClock },
];

export function DashboardShell({
  guildId,
  guildName,
  canEdit,
  children,
}: {
  guildId: string;
  guildName: string;
  canEdit: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
          <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
            <Server size={18} />
            comebacktwitterembed
          </Link>
          <div className="flex min-w-0 items-center gap-3">
            <span className="hidden truncate text-sm text-muted-foreground md:inline">{guildName}</span>
            <Badge tone={canEdit ? "success" : "muted"}>{canEdit ? "編集可" : "閲覧のみ"}</Badge>
            <SignOutButton />
          </div>
        </div>
      </header>
      <div className="dashboard-grid mx-auto max-w-7xl gap-5 px-4 py-5">
        <aside className="space-y-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const href = item.href ? `/dashboard/${guildId}/${item.href}` : `/dashboard/${guildId}`;
            return (
              <Link
                key={item.href || "overview"}
                href={href}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon size={16} />
                {item.label}
              </Link>
            );
          })}
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
