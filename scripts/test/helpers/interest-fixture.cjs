'use strict';
const { DatabaseSync } = require('node:sqlite');
const loadDashboard = require('./load-dashboard.cjs');
const { detailedInterestQuery } = loadDashboard('lib/analytics-interest-query.ts');

function originalQuery(where) {
    return `SELECT target.provider_id AS target_provider_id, target.account_key AS target_account_key,
        other.provider_id AS interest_provider_id, other.account_key AS interest_account_key,
        other.content_type AS interest_content_type, COUNT(*) AS co_events,
        COUNT(DISTINCT target.author_user_id) AS shared_users, COUNT(DISTINCT target.guild_id) AS shared_guilds
        FROM bot_provider_content_events target JOIN bot_provider_content_events other
        ON other.author_user_id = target.author_user_id AND other.occurred_at_ms >= ? AND other.occurred_at_ms <= ?
        WHERE ${where} AND target.author_user_id IS NOT NULL AND other.provider_id IS NOT NULL
        AND (other.provider_id <> target.provider_id OR COALESCE(other.account_key, '') <> COALESCE(target.account_key, ''))
        GROUP BY target.provider_id, target.account_key, other.provider_id, other.account_key, other.content_type
        ORDER BY co_events DESC LIMIT ?`;
}

function createFixture(rows) {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE bot_provider_content_events (
        content_event_id INTEGER PRIMARY KEY, occurred_at_ms INTEGER, author_user_id TEXT,
        provider_id TEXT, account_key TEXT, guild_id TEXT, content_type TEXT);
        CREATE INDEX by_user_time ON bot_provider_content_events(author_user_id, occurred_at_ms);
        CREATE INDEX by_time ON bot_provider_content_events(occurred_at_ms);
        CREATE TABLE bot_provider_content_facets(content_event_id INTEGER, facet_key TEXT);`);
    const insert = db.prepare('INSERT INTO bot_provider_content_events VALUES (?, ?, ?, ?, ?, ?, ?)');
    const facet = db.prepare('INSERT INTO bot_provider_content_facets VALUES (?, ?)');
    db.exec('BEGIN');
    rows.forEach((row, index) => {
        insert.run(index + 1, row.time, row.user, row.provider, row.account, row.guild, row.type);
        if (index % 3 === 0) facet.run(index + 1, 'tag');
    });
    db.exec('COMMIT');
    return db;
}

const normalize = rows => rows.map(row => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
module.exports = { originalQuery, detailedInterestQuery, createFixture, normalize };
