"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RefreshCw, Server, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import NextError from "next/error";
import { useDashboardUIVersion } from "@/components/dashboard/dashboard-ui-provider";

export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const version = useDashboardUIVersion();
  const [ja, setJa] = useState(true);
  useEffect(() => { setJa(document.documentElement.lang !== "en"); }, []);
  if (version !== "preview") return <NextError statusCode={500} />;
  return <main className="mx-auto grid min-h-[60vh] max-w-xl content-center gap-5 px-5 py-12">
    <TriangleAlert size={32} className="text-destructive" aria-hidden />
    <h1 className="text-2xl font-semibold">{ja ? "画面を読み込めませんでした" : "Could not load this page"}</h1>
    <div className="flex flex-wrap gap-3"><Button onClick={reset}><RefreshCw size={16} aria-hidden />{ja ? "もう一度読み込む" : "Try again"}</Button><Button variant="outline" asChild><Link href="/dashboard?mode=user"><Server size={16} aria-hidden />{ja ? "サーバー一覧へ戻る" : "Back to servers"}</Link></Button></div>
  </main>;
}
