'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { originalQuery, detailedInterestQuery, createFixture, normalize } = require('./helpers/interest-fixture.cjs');

test('preaggregated interest query preserves raw join counts across filters, repeats, nulls and boundary times', () => {
    let seed = 1729;
    const pick = values => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return values[Math.floor(seed / 65536) % values.length];
    };
    const rows = Array.from({ length: 450 }, () => ({
        time: pick([99, 100, 150, 200, 201]), user: pick(['u1', 'u2', 'u3', null]),
        provider: pick(['twitter', 'youtube', 'pixiv', null]), account: pick(['a', 'b', '', null]),
        guild: pick(['g1', 'g2', null]), type: pick(['video', 'image', null]),
    }));
    rows.push(...Array.from({ length: 25 }, () => ({ time: 150, user: 'u1', provider: 'twitter', account: 'a', guild: 'g1', type: 'video' })));
    rows.push({ time: 150, user: 'u1', provider: 'youtube', account: 'b', guild: 'g2', type: 'video' });
    const db = createFixture(rows);
    try {
        for (const [extra, params] of [
            ['', []], [' AND target.guild_id = ?', ['g1']], [' AND target.provider_id = ?', ['twitter']],
            [' AND target.account_key = ?', ['']], [' AND target.author_user_id = ?', ['u2']],
            [' AND target.content_type = ?', ['video']],
            [' AND EXISTS (SELECT 1 FROM bot_provider_content_facets f_filter WHERE f_filter.content_event_id = target.content_event_id AND f_filter.facet_key = ?)', ['tag']],
            [' AND target.guild_id = ? AND target.provider_id = ?', ['g1', 'twitter']],
        ]) {
            const where = 'target.occurred_at_ms >= ? AND target.occurred_at_ms <= ?' + extra;
            const original = db.prepare(originalQuery(where)).all(100, 200, 100, 200, ...params, 10000);
            assert.ok(original.length > 0, 'fixture must exercise actual joins');
            const optimized = db.prepare(detailedInterestQuery(where)).all(100, 200, ...params, 100, 200, 10000);
            assert.deepEqual(normalize(optimized), normalize(original), extra || 'unfiltered');
        }
        const where = 'target.occurred_at_ms >= ? AND target.occurred_at_ms <= ?';
        assert.equal(db.prepare(detailedInterestQuery(where)).all(100, 200, 100, 200, 1).length, 1);
        assert.equal(db.prepare(detailedInterestQuery(where)).all(1000, 2000, 1000, 2000, 100).length, 0);
    } finally { db.close(); }
});
