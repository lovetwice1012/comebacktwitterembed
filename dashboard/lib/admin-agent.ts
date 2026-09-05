import "server-only";

/** The bearer token never enters the browser. Only the configured local agent is contacted. */
export function adminAgentEndpoint(path: string) {
  const base = new URL(process.env.ADMIN_AGENT_URL || "http://127.0.0.1:30988");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.protocol !== "http:") {
    throw new Error("ADMIN_AGENT_URL must be a local HTTP endpoint.");
  }
  return new URL(`/v1/${path}`, base);
}

export function independentAdminUrl() {
  const value = process.env.ADMIN_AGENT_PUBLIC_URL;
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
