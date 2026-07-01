import Link from "next/link";
import { Bot, ExternalLink } from "lucide-react";
import { SignInButton } from "@/components/dashboard/auth-buttons";
import { LanguageSwitcher } from "@/components/dashboard/language-switcher";
import { Button } from "@/components/ui/button";
import { createTranslator } from "@/lib/i18n";
import { getDashboardLocale } from "@/lib/server-locale";
import { getDashboardSession } from "@/lib/server-session";

const BOT_INVITE_URL =
  "https://discord.com/oauth2/authorize?client_id=1161267455335862282&permissions=274877958144&scope=bot%20applications.commands";

export default async function HomePage() {
  const locale = await getDashboardLocale();
  const t = createTranslator(locale);
  const session = await getDashboardSession();

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-4 py-10">
      <section className="space-y-4">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Bot size={24} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="break-words text-2xl font-semibold tracking-normal sm:text-3xl">comebacktwitterembed Dashboard</h1>
            <p className="text-muted-foreground">{t("home.subtitle")}</p>
          </div>
          <LanguageSwitcher locale={locale} />
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          {session ? (
            <Button asChild className="w-full sm:w-auto">
              <Link href="/dashboard">{t("home.openGuilds")}</Link>
            </Button>
          ) : (
            <SignInButton locale={locale} />
          )}
          <Button asChild className="w-full sm:w-auto" variant="outline">
            <a href={BOT_INVITE_URL} target="_blank" rel="noreferrer">
              <ExternalLink size={16} />
              {t("home.inviteBot")}
            </a>
          </Button>
        </div>
      </section>
    </main>
  );
}
