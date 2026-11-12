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
  // Runtime download uses requireBotModule, whose evaluated require is not
  // discoverable by Next's automatic file tracing. Include only release inputs.
  outputFileTracingIncludes: {
    "/api/automation/x-setup/download-chrome-mac": [
      "../src/**/*.js",
      "../packages/angelic-angel/dist/**",
      "../src/automation/x-chrome-mac-release.js",
      "../artifacts/angelic-setup/chrome-mac-*.zip",
    ],
    "/api/automation/x-setup/download-edge": [
      "../src/**/*.js",
      "../packages/angelic-angel/dist/**",
      "../artifacts/angelic-setup/edge-setup-0.1.0-edge-preview.9.zip",
    ],
    "/api/automation/x-setup/download-chrome": [
      "../src/providers/_loader.js",
      "../artifacts/angelic-setup/chrome-setup-0.1.0-chrome-preview.9.zip",
    ],
    "/api/automation/x-setup/download": [
      // repoRoot() uses this existing directory as its runtime layout marker.
      "../src/providers/_loader.js",
      "../src/automation/x-setup-release.js",
      "../scripts/build-angelic-setup-package.cjs",
      "../node_modules/fflate/package.json",
      "../node_modules/fflate/lib/node.cjs",
      "../node_modules/fflate/lib/node-worker.cjs",
      "../client/angelic-setup/LICENSE",
      "../client/angelic-setup/README-ja.md",
      "../client/angelic-setup/Setup-XNotifications.ps1",
      "../client/angelic-setup/Start-Setup.ps1",
      "../client/angelic-setup/FirefoxReader.ps1",
      "../client/angelic-setup/Export-XNotificationData.ps1",
      "../client/angelic-setup/Read-PushSubscription.js",
      "../client/angelic-setup/はじめに読んでください.txt",
      "../client/angelic-setup/ダブルクリックで開始.cmd",
    ],
  },
};

export default nextConfig;
