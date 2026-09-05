'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const loadDashboard = require('./helpers/load-dashboard.cjs');
const { audienceInterestQuery } = loadDashboard('lib/audience-interest-query.ts');

test('audience ranking retains weighted activity, users and distinct guilds with repeated cross-guild posts', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE bot_analytics_events(author_user_id TEXT,provider_id TEXT,account_key TEXT,guild_id TEXT,endpoint_key TEXT,event_type TEXT,occurred_at_ms INTEGER)`);
    const insert = db.prepare('INSERT INTO bot_analytics_events VALUES (?,?,?,?,?,?,?)');
    for (let user = 0; user < 8; user++) {
        for (let guild = 0; guild < 30; guild++) {
            for (let repeat = 0; repeat < 3; repeat++) {
                insert.run(String(user), 'twitter', 'a', String(guild), '/a', 'provider_extract', 100);
                insert.run(String(user), 'youtube', 'b', String(guild), null, 'provider_extract', 100);
            }
        }
    }
    insert.run('0', null, 'c', null, '/c', 'provider_extract', 100);
    insert.run('0', 'pixiv', null, null, null, 'provider_extract', 100);
    insert.run('0', 'pixiv', '', null, '', 'provider_extract', 100);
    insert.run(null, 'pixiv', 'z', 'z', '/z', 'provider_extract', 100);
    insert.run('0', 'pixiv', 'old', 'z', '/z', 'provider_extract', 1);
    const original = `SELECT target.provider_id AS target_provider_id,target.account_key AS target_account_key,
        other.provider_id AS interest_provider_id,other.account_key AS interest_account_key,other.endpoint_key AS interest_endpoint_key,
        COUNT(*) AS co_activity,COUNT(DISTINCT target.author_user_id) AS shared_users,COUNT(DISTINCT target.guild_id) AS shared_guilds
        FROM bot_analytics_events target JOIN bot_analytics_events other ON other.author_user_id=target.author_user_id
        WHERE target.occurred_at_ms >= ? AND other.occurred_at_ms >= ?
        AND target.event_type='provider_extract' AND other.event_type='provider_extract'
        AND target.author_user_id IS NOT NULL AND target.account_key IS NOT NULL AND other.provider_id IS NOT NULL
        AND (other.provider_id <> target.provider_id OR COALESCE(other.account_key,'') <> COALESCE(target.account_key,''))
        GROUP BY target.provider_id,target.account_key,other.provider_id,other.account_key,other.endpoint_key
        ORDER BY co_activity DESC LIMIT 100`;
    // SQLite's IS is the equivalent null-safe equality for these text values.
    const optimized = audienceInterestQuery.replaceAll('<=>', 'IS');
    const normalize = rows => rows.map(row => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    try {
        const expected = db.prepare(original).all(50, 50);
        assert.ok(expected.length > 0 && expected.length < 100);
        assert.deepEqual(normalize(db.prepare(optimized).all(50, 50)), normalize(expected));
    } finally { db.close(); }
});
