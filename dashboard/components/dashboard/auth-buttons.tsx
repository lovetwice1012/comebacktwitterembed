"use client";

import { LogIn, LogOut } from "lucide-react";
import { signIn, signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { createTranslator, type DashboardLocale } from "@/lib/i18n";

export function SignInButton({ locale = "ja" }: { locale?: DashboardLocale }) {
  const t = createTranslator(locale);
  return (
    <Button onClick={() => signIn("discord", { callbackUrl: "/dashboard" })}>
      <LogIn size={16} />
      {t("auth.signIn")}
    </Button>
  );
}

export function SignOutButton({ locale = "ja" }: { locale?: DashboardLocale }) {
  const t = createTranslator(locale);
  return (
    <Button variant="ghost" onClick={() => signOut({ callbackUrl: "/" })}>
      <LogOut size={16} />
      {t("auth.signOut")}
    </Button>
  );
}
