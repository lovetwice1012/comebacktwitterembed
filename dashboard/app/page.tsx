import Link from "next/link";
import { Bot, ExternalLink, ShieldCheck } from "lucide-react";
import { SignInButton } from "@/components/dashboard/auth-buttons";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getDashboardSession } from "@/lib/server-session";

export default async function HomePage() {
  const session = await getDashboardSession();

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center gap-6 px-4 py-10">
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Bot size={24} />
          </div>
          <div>
            <h1 className="text-3xl font-semibold tracking-normal">comebacktwitterembed Dashboard</h1>
            <p className="text-muted-foreground">Provider設定を安全に編集する管理画面</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          {session ? (
            <Button asChild>
              <Link href="/dashboard">管理可能サーバーを開く</Link>
            </Button>
          ) : (
            <SignInButton />
          )}
          <Button asChild variant="outline">
            <a href="https://discord.com/oauth2/authorize" target="_blank" rel="noreferrer">
              <ExternalLink size={16} />
              Botを招待
            </a>
          </Button>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>カタログ駆動</CardTitle>
            <CardDescription>Bot側の provider settings から画面を生成します。</CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>保存前検証</CardTitle>
            <CardDescription>Zod検証、競合解決、危険設定の警告を通します。</CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>監査ログ</CardTitle>
            <CardDescription>誰が何を変えたかをMySQLに記録します。</CardDescription>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardContent className="flex items-center gap-3 pt-4 text-sm text-muted-foreground">
          <ShieldCheck size={16} />
          Discordの Manage Channels / Manage Server / Administrator 権限をサーバー側でも確認します。
        </CardContent>
      </Card>
    </main>
  );
}
