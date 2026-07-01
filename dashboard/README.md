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
    "discordApiTimeoutMs": 8000
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

Database connection can be provided by `DATABASE_URL`. If it is absent, the dashboard derives the MySQL URL from the root `config.json` `db` section or the legacy DB defaults used by the bot.

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
Bot-managed startup uses `npm run start` by default. If the production build is missing, the start script runs `npm run build` once before `next start`, so users do not see Next.js development tools during normal Bot startup.

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
