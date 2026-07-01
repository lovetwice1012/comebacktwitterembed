"use client";

import { Globe2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { createTranslator, DASHBOARD_LOCALES, type DashboardLocale } from "@/lib/i18n";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function LanguageSwitcher({ locale }: { locale: DashboardLocale }) {
  const router = useRouter();
  const t = createTranslator(locale);

  function setLocale(next: DashboardLocale) {
    document.cookie = `dashboard_locale=${encodeURIComponent(next)};path=/;max-age=${COOKIE_MAX_AGE};SameSite=Lax`;
    router.refresh();
  }

  return (
    <label className="flex items-center gap-2 rounded-md border bg-card px-2 text-sm text-muted-foreground">
      <Globe2 size={15} />
      <span className="sr-only">{t("language.label")}</span>
      <select
        className="h-9 bg-transparent text-sm outline-none"
        value={locale}
        aria-label={t("language.label")}
        onChange={(event) => setLocale(event.target.value as DashboardLocale)}
      >
        {DASHBOARD_LOCALES.map((item) => (
          <option key={item} value={item}>
            {t(item === "ja" ? "language.ja" : "language.en")}
          </option>
        ))}
      </select>
    </label>
  );
}
