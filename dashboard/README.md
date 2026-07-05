# comebacktwitterembed Dashboard

Next.js based Web Dashboard for editing provider settings stored in the existing MySQL schema.

## Configuration

Dashboard and media delivery configuration is read from the root `config.json`.

```json
{
  "token": "Discord Bot Token",
  "URL": "console webhook URL",
  "clientId": "Discord OAuth application client id",
  "clientSecret": "Discord OAuth application client secret",
  "nextAuthSecret": "long random string",
  "dashboard": {
    "enabled": true,
    "port": 30987,
    "publicBaseUrl": "https://your-dashboard.example.com",
    "useBotGuildApi": false,
    "loadGuildProviderSummary": false,
    "discordApiTimeoutMs": 8000,
    "dbConnectionLimit": 2,
    "adminAnalyticsPrewarm": false
  },
  "mediaDelivery": {
    "publicBaseUrl": "https://your-dashboard.example.com",
    "serverMode": "dashboard",
    "useLegacyRoutes": false,
    "ttlMs": 1800000,
    "youtubeDownloadButtonEnabled": false,
    "niconicoDownloadButtonEnabled": true
  }
}
```

`DISCORD_BOT_TOKEN` is not required for Dashboard login. The dashboard normally checks bot-installed guilds from the existing MySQL `guilds` table. Set `dashboard.useBotGuildApi` to `true` only if you explicitly want the dashboard to call Discord's bot guild API, which can be slow for bots installed in many guilds.

Database connection can be provided by `DATABASE_URL`. If it is absent, the dashboard derives the MySQL URL from the root `config.json` `db` section or the legacy DB defaults used by the bot. The dashboard appends a Prisma MySQL `connection_limit` of `2` by default so analytics pages cannot occupy the database pool; override with `DASHBOARD_DB_CONNECTION_LIMIT` or `dashboard.dbConnectionLimit`.

Admin analytics reports are served from in-memory snapshots. Requests and manual refreshes queue background regeneration and return immediately with the latest available snapshot. Startup prewarming is disabled by default; set `DASHBOARD_ADMIN_ANALYTICS_PREWARM=1` or `dashboard.adminAnalyticsPrewarm: true` only on hosts that can absorb report generation during boot.

## Integrated media routes

The Dashboard server also serves downloaded media cache files:

- `/media/youtube/:token/:filename`
- `/media/niconico/:token/:filename`
- `/youtube-downloads/:token/:filename` for legacy compatibility
- `/niconico-downloads/:token/:filename` for legacy compatibility

When the dashboard and media delivery use the same domain, set the same URL in `dashboard.publicBaseUrl` and `mediaDelivery.publicBaseUrl`. Environment variables are still accepted as emergency overrides, but normal operation should be managed through `config.json`.

New download URLs prefer the unified `/media/...` routes. Set `MEDIA_DELIVERY_USE_LEGACY_ROUTES=true` only if new Bot messages must keep generating legacy download URLs.

For local Dashboard-only development:

```bash
npm run dev
# http://localhost:30987
```

When the Bot starts, it also starts this dashboard as a child process on `30987`.
The Bot process sets dashboard-integrated media mode automatically, so it does not start the old Express listener on the same port.
Bot-managed startup uses the production start wrapper by default. If the production build is missing, the wrapper creates one before `next start`, so users do not see Next.js development tools during normal Bot startup.

Production dashboard builds are written to versioned directories under `dashboard/.next-builds/` and activated through `dashboard/.next-builds/current.json`. This keeps new builds separate from the build currently used by `next start`, so you can run `npm run build` while the Bot-managed dashboard is online. When the build pointer changes, the dashboard wrapper restarts only the Next.js child process and the Bot keeps running.

To keep online rebuilds from touching DLLs loaded by the running dashboard on Windows, `npm run build` reuses an existing Prisma Client. If `prisma/schema.prisma` changes and regenerated Prisma types are required, stop the dashboard, set `DASHBOARD_FORCE_PRISMA_GENERATE=1`, and run `npm run build`.

Useful `config.json` switches:

- `dashboard.enabled: false` disables automatic dashboard startup from the Bot process.
- `dashboard.npmScript: "dev"` intentionally forces development mode. Leave it unset or set `"start"` for normal operation.
- `mediaDelivery.serverMode: "express"` intentionally uses the standalone Express media server instead of dashboard-integrated routes.

## Commands

```bash
npm install
npm run dev
npm run typecheck
npm run lint
npm run build
```

The dashboard writes provider settings to the same tables consumed by `src/providers/_provider_settings.js`. The audit table is created by `migrations/20260701_add_dashboard_audit_logs.sql` and also guarded at runtime with `CREATE TABLE IF NOT EXISTS`.
