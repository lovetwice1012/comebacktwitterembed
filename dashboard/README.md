# comebacktwitterembed Dashboard

Next.js based Web Dashboard for editing provider settings stored in the existing MySQL schema.

## Required environment

- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `NEXTAUTH_SECRET`
- `NEXTAUTH_URL`, for example `http://localhost:3000`
- `DISCORD_BOT_TOKEN` or the root `config.json` `token`

Database connection can be provided by `DATABASE_URL`. If it is absent, the dashboard derives the MySQL URL from the root `config.json` `db` section or the legacy DB defaults used by the bot.

## Commands

```bash
npm install
npm run dev
npm run typecheck
npm run lint
npm run build
```

The dashboard writes provider settings to the same tables consumed by `src/providers/_provider_settings.js`. The audit table is created by `migrations/20260701_add_dashboard_audit_logs.sql` and also guarded at runtime with `CREATE TABLE IF NOT EXISTS`.
