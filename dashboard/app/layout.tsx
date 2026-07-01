import type { Metadata } from "next";
import "./globals.css";
import { createTranslator } from "@/lib/i18n";
import { getDashboardLocale } from "@/lib/server-locale";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getDashboardLocale();
  const t = createTranslator(locale);
  return {
    title: t("metadata.title"),
    description: t("metadata.description"),
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getDashboardLocale();
  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
