import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "prisma", "mysql", "discord.js"],
  outputFileTracingRoot: path.join(process.cwd(), ".."),
};

export default nextConfig;
