import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createTranslator, type DashboardLocale } from "@/lib/i18n";

export function AccessDenied({
  required = "Manage Channels / Manage Server / Administrator",
  locale = "ja",
  guildId,
}: {
  required?: string;
  locale?: DashboardLocale;
  guildId?: string;
}) {
  const t = createTranslator(locale);
  return (
    <main className="mx-auto max-w-2xl p-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert size={18} />
            {t("accessDenied.title")}
          </CardTitle>
          <CardDescription>{t("accessDenied.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div>{t("accessDenied.required", { required })}</div>
          <div className="text-muted-foreground">{t("accessDenied.adminHelp")}</div>
          <div className="flex flex-wrap gap-2 pt-3">
            {guildId && <Button asChild variant="outline"><Link href={`/dashboard/${guildId}/providers`}>{locale === "ja" ? "サーバーの設定へ戻る" : "Back to server settings"}</Link></Button>}
            <Button asChild variant="outline"><Link href="/dashboard?mode=user">{locale === "ja" ? "サーバーを選び直す" : "Choose another server"}</Link></Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
