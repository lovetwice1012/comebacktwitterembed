export function authenticationErrorMessage(error: unknown, locale = "ja"): string | null {
  if (typeof error !== "string" || !error) return null;
  // The query string is untrusted. Never echo it or backend exception details.
  if (error === "AccessDenied") return locale === "ja"
    ? "Discord認証が許可されませんでした。ログインをやり直して確認してください。"
    : "Discord sign-in was not authorized. Please try signing in again.";
  return locale === "ja"
    ? "Discord認証を完了できませんでした。もう一度ログインしてください。繰り返す場合はサポートへご連絡ください。"
    : "Discord sign-in could not be completed. Please try again, or contact support if it keeps failing.";
}
