'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const loadDashboard = require('./helpers/load-dashboard.cjs');
const { compactUniqueMembershipCount } = loadDashboard('lib/unique-membership-query.ts');

test('membership projection keeps exact distinct counts, null-only groups, empty windows and parameter order', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE bot_provider_hourly_unique_keys(provider_id TEXT,account_key TEXT,key_type TEXT,key_hash TEXT,bucket_start_ms INTEGER)');
    const insert = db.prepare('INSERT INTO bot_provider_hourly_unique_keys VALUES (?,?,?,?,?)');
    for (let i = 0; i < 500; i++) {
        const row = ['p' + i % 2, i % 3 ? 'a' : '', i % 2 ? 'guild' : 'user', 'hash' + i % 13, (i % 24) * 1000];
        insert.run(...row); insert.run(...row);
    }
    insert.run('nulls','a','user',null,1000);
    const cases = [
        ['SELECT provider_id,account_key,key_type,COUNT(DISTINCT key_hash) AS unique_count FROM bot_provider_hourly_unique_keys WHERE bucket_start_ms>=? GROUP BY provider_id,account_key,key_type', [0]],
        ['SELECT provider_id,FLOOR(bucket_start_ms / ?) * ? AS bucket,key_type,COUNT(DISTINCT key_hash) AS unique_count FROM bot_provider_hourly_unique_keys WHERE bucket_start_ms>=? GROUP BY provider_id,bucket,key_type ORDER BY bucket LIMIT 200', [5000,5000,0]],
        ['SELECT COUNT(DISTINCT key_hash) AS total_users FROM bot_provider_hourly_unique_keys WHERE bucket_start_ms>=?', [0]],
        ['SELECT COUNT(DISTINCT key_hash) AS total_users FROM bot_provider_hourly_unique_keys WHERE bucket_start_ms>=?', [999999]],
    ];
    const normalize = rows => rows.map(row=>({...row})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    try {
        for (const [sql, params] of cases) {
            const optimized = compactUniqueMembershipCount(sql);
            assert.notEqual(optimized, sql);
            assert.deepEqual(normalize(db.prepare(optimized).all(...params)), normalize(db.prepare(sql).all(...params)));
        }
        const unrelated = 'SELECT COUNT(DISTINCT key_hash) AS n FROM other_table WHERE time>?';
        assert.equal(compactUniqueMembershipCount(unrelated), unrelated);
        const nested = 'SELECT key_type,COUNT(DISTINCT key_hash) AS n FROM bot_provider_hourly_unique_keys WHERE key_hash IN (SELECT hash FROM other_table) GROUP BY key_type';
        assert.equal(compactUniqueMembershipCount(nested), nested);
    } finally { db.close(); }
});
