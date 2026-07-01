import Link from "next/link";
import { Bot, ExternalLink } from "lucide-react";
import { SignInButton } from "@/components/dashboard/auth-buttons";
import { LanguageSwitcher } from "@/components/dashboard/language-switcher";
import { Button } from "@/components/ui/button";
import { createTranslator } from "@/lib/i18n";
import { getDashboardLocale } from "@/lib/server-locale";
import { getDashboardSession } from "@/lib/server-session";

export default async function HomePage() {
  const locale = await getDashboardLocale();
  const t = createTranslator(locale);
  const session = await getDashboardSession();

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-4 py-10">
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Bot size={24} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-3xl font-semibold tracking-normal">comebacktwitterembed Dashboard</h1>
            <p className="text-muted-foreground">{t("home.subtitle")}</p>
          </div>
          <LanguageSwitcher locale={locale} />
        </div>
        <div className="flex flex-wrap gap-3">
          {session ? (
            <Button asChild>
              <Link href="/dashboard">{t("home.openGuilds")}</Link>
            </Button>
          ) : (
            <SignInButton locale={locale} />
          )}
          <Button asChild variant="outline">
            <a href="https://discord.com/oauth2/authorize" target="_blank" rel="noreferrer">
              <ExternalLink size={16} />
              {t("home.inviteBot")}
            </a>
          </Button>
        </div>
      </section>
    </main>
  );
}
