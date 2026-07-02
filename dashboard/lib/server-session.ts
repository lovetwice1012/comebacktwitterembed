import "server-only";

import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/features/auth/options";
import { isDashboardAdminUserId } from "@/lib/admin";
import type { DashboardSession } from "@/lib/types";

export async function getDashboardSession(): Promise<DashboardSession | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session.accessToken) return null;
  return {
    user: {
      id: session.user.id,
      username: session.user.username || session.user.name || "",
      globalName: session.user.globalName,
      avatarUrl: session.user.avatarUrl,
      isAdmin: isDashboardAdminUserId(session.user.id),
    },
    accessToken: session.accessToken,
    expiresAt: session.expiresAt,
  };
}

export async function requireDashboardSession() {
  const session = await getDashboardSession();
  if (!session) redirect("/");
  return session;
}
