"use client";

import { LogIn, LogOut } from "lucide-react";
import { signIn, signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";

export function SignInButton() {
  return (
    <Button onClick={() => signIn("discord", { callbackUrl: "/dashboard" })}>
      <LogIn size={16} />
      Discordでログイン
    </Button>
  );
}

export function SignOutButton() {
  return (
    <Button variant="ghost" onClick={() => signOut({ callbackUrl: "/" })}>
      <LogOut size={16} />
      ログアウト
    </Button>
  );
}
