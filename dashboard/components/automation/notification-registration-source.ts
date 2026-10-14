/** Parse only an explicit X account input. No lookup, URL fetch or ID inference. */
export function xRegistrationHandle(source: string): string {
  const input = source.trim();
  if (/^@?[A-Za-z0-9_]{1,15}$/.test(input)) return input.replace(/^@/, "");
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname.toLowerCase())) throw new Error();
    const match = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(url.pathname);
    if (!match || ["i", "home", "explore", "notifications", "messages", "settings", "search", "intent"].includes(match[1].toLowerCase())) throw new Error();
    return match[1];
  } catch { throw new Error("Xの@ユーザー名、またはプロフィールのURLを入力してください。"); }
}
