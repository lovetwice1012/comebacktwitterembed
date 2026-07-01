import type { NextAuthOptions } from "next-auth";
import DiscordProvider from "next-auth/providers/discord";
import { getClientId, getClientSecret, getNextAuthSecret } from "@/lib/env";

export const authOptions: NextAuthOptions = {
  secret: getNextAuthSecret(),
  session: {
    strategy: "jwt",
  },
  providers: [
    DiscordProvider({
      clientId: getClientId(),
      clientSecret: getClientSecret(),
      authorization: {
        params: {
          scope: "identify guilds",
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account?.access_token) token.accessToken = account.access_token;
      if (account?.expires_at) token.expiresAt = account.expires_at * 1000;
      if (profile) {
        const discordProfile = profile as { id?: string; username?: string; global_name?: string | null; avatar?: string | null };
        token.discordId = discordProfile.id;
        token.username = discordProfile.username;
        token.globalName = discordProfile.global_name;
        token.avatarHash = discordProfile.avatar;
      }
      return token;
    },
    async session({ session, token }) {
      const id = String(token.discordId || session.user?.email || "");
      session.user = {
        ...session.user,
        id,
        username: String(token.username || session.user?.name || ""),
        globalName: typeof token.globalName === "string" ? token.globalName : null,
        avatarUrl: token.avatarHash ? `https://cdn.discordapp.com/avatars/${id}/${token.avatarHash}.png?size=128` : session.user?.image || null,
      };
      session.accessToken = String(token.accessToken || "");
      session.expiresAt = Number(token.expiresAt || 0);
      return session;
    },
  },
  pages: {
    signIn: "/",
  },
};
