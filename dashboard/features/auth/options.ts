import type { NextAuthOptions } from "next-auth";
import type { JWT } from "next-auth/jwt";
import DiscordProvider from "next-auth/providers/discord";
import { getClientId, getClientSecret, getNextAuthSecret } from "@/lib/env";

const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
const TOKEN_REFRESH_SKEW_MS = 60_000;

async function refreshDiscordAccessToken(token: JWT): Promise<JWT> {
  if (!token.refreshToken) {
    return { ...token, accessToken: undefined, expiresAt: 0, error: "MissingRefreshToken" };
  }

  try {
    const body = new URLSearchParams({
      client_id: getClientId(),
      client_secret: getClientSecret(),
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
    });

    const res = await fetch(DISCORD_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    });

    const data = await res.json().catch(() => ({})) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };

    if (!res.ok || !data.access_token) {
      return { ...token, accessToken: undefined, expiresAt: 0, error: "RefreshAccessTokenError" };
    }

    return {
      ...token,
      accessToken: data.access_token,
      expiresAt: Date.now() + Number(data.expires_in || 0) * 1000,
      refreshToken: data.refresh_token || token.refreshToken,
      error: undefined,
    };
  } catch {
    return { ...token, accessToken: undefined, expiresAt: 0, error: "RefreshAccessTokenError" };
  }
}

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
      if (account?.access_token) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token || token.refreshToken;
        token.expiresAt = account.expires_at
          ? account.expires_at * 1000
          : Date.now() + Number(account.expires_in || 0) * 1000;
        token.error = undefined;
      }
      if (profile) {
        const discordProfile = profile as { id?: string; username?: string; global_name?: string | null; avatar?: string | null };
        token.discordId = discordProfile.id;
        token.username = discordProfile.username;
        token.globalName = discordProfile.global_name;
        token.avatarHash = discordProfile.avatar;
      }
      if (token.accessToken && token.expiresAt && Date.now() < token.expiresAt - TOKEN_REFRESH_SKEW_MS) return token;
      if (token.accessToken) return refreshDiscordAccessToken(token);
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
      session.accessToken = token.error ? "" : String(token.accessToken || "");
      session.expiresAt = Number(token.expiresAt || 0);
      session.error = token.error;
      return session;
    },
  },
  pages: {
    signIn: "/",
  },
};
