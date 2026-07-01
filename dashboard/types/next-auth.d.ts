import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    accessToken: string;
    expiresAt: number;
    user: DefaultSession["user"] & {
      id: string;
      username: string;
      globalName?: string | null;
      avatarUrl?: string | null;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    expiresAt?: number;
    discordId?: string;
    username?: string;
    globalName?: string | null;
    avatarHash?: string | null;
  }
}
