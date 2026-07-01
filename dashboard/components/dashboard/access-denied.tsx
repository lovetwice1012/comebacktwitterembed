import { ShieldAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createTranslator, type DashboardLocale } from "@/lib/i18n";

export function AccessDenied({
  required = "Manage Channels / Manage Server / Administrator",
  locale = "ja",
}: {
  required?: string;
  locale?: DashboardLocale;
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
        </CardContent>
      </Card>
    </main>
  );
}
