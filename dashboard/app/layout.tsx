import type { Metadata } from "next";
import "./globals.css";
import { createTranslator } from "@/lib/i18n";
import { getDashboardLocale } from "@/lib/server-locale";
import { getDashboardSession } from "@/lib/server-session";
import { usesNewDashboardUI } from "@/lib/ui-rollout";
import { DashboardUIProvider } from "@/components/dashboard/dashboard-ui-provider";
import { createTranslator as createLegacyTranslator } from "@/legacy/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getDashboardLocale();
  const session = await getDashboardSession();
  const t = (await usesNewDashboardUI(session) ? createTranslator : createLegacyTranslator)(locale);
  return {
    title: t("metadata.title"),
    description: t("metadata.description"),
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getDashboardLocale();
  const session = await getDashboardSession();
  const version = await usesNewDashboardUI(session) ? "preview" : "legacy";
  return (
    <html lang={locale} data-dashboard-ui={version}>
      <body><DashboardUIProvider version={version} authenticated={Boolean(session)} locale={locale}>{children}</DashboardUIProvider></body>
    </html>
  );
}
