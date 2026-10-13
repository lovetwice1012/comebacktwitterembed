import { LoaderCircle } from "lucide-react";
import { getDashboardLocale } from "@/lib/server-locale";
import { getDashboardSession } from "@/lib/server-session";
import { usesNewDashboardUI } from "@/lib/ui-rollout";

export default async function DashboardLoading() {
  if (!await usesNewDashboardUI(await getDashboardSession())) return null;
  const locale = await getDashboardLocale();
  return <div className="mx-auto flex min-h-[40vh] max-w-xl items-center justify-center gap-3 px-5" role="status"><LoaderCircle size={22} className="animate-spin text-primary" aria-hidden /><span>{locale === "ja" ? "読み込み中" : "Loading"}</span></div>;
}
