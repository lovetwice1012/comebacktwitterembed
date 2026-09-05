import type { NextConfig } from "next";
import path from "node:path";

const distDir = process.env.DASHBOARD_NEXT_DIST_DIR?.trim() || ".next";

const nextConfig: NextConfig = {
  distDir,
  // The production host also runs MySQL and the Bot. Do not launch one
  // static-generation worker per CPU while rebuilding the dashboard.
  experimental: { cpus: 2 },
  serverExternalPackages: ["@prisma/client", "prisma", "mysql", "discord.js"],
  outputFileTracingRoot: path.join(process.cwd(), ".."),
};

export default nextConfig;
