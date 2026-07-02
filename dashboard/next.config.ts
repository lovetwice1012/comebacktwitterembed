import type { NextConfig } from "next";
import path from "node:path";

const distDir = process.env.DASHBOARD_NEXT_DIST_DIR?.trim() || ".next";

const nextConfig: NextConfig = {
  distDir,
  serverExternalPackages: ["@prisma/client", "prisma", "mysql", "discord.js"],
  outputFileTracingRoot: path.join(process.cwd(), ".."),
};

export default nextConfig;
