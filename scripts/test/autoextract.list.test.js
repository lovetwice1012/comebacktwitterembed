'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');

function loadList(legacy, watches, calls = []) {
    const filename = path.resolve(__dirname, '../../src/commands/handlers/autoextract/list.js');
    const realRequire = createRequire(filename);
    const mod = { exports: {} };
    const mocks = {
        '../../../db': { queryDatabase: async (sql, params) => { calls.push({ sql, params }); return legacy; } },
        '../../../providers/autoWatch/store': { listTargets: async user => { calls.push({ user }); return watches; } },
    };
    compileFunction(readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(
        id => mocks[id] || realRequire(id), mod, mod.exports);
    return mod.exports;
}

test('auto watch list shows active, paused, initial and failing monitors with relative check times', async () => {
    const base = { id: '1', providerId: 'youtube', sourceUrl: 'https://www.youtube.com/channel/fixture', destinationType: 'dm', enabled: true,
        lastCheckedAtMs: 1800000000000, nextCheckAtMs: 1800000030000 };
    const calls = [], replies = [];
    const list = loadList([], [base, { ...base, id: '2', enabled: false }, { ...base, id: '3', lastCheckedAtMs: 0 },
        { ...base, id: '4', failureCount: 2, lastErrorCode: 'AUTO_WATCH_RATE_LIMITED' },
        { ...base, id: '5', failureCount: 1, lastErrorCode: 'INTERNAL_SECRET_CODE', destinationType: 'webhook', webhookEndpointId: '88' }], calls);
    await list({ locale: 'ja', user: { id: 'owner' }, editReply: async payload => replies.push(payload) });
    const text = replies[0].embeds[0].description;
    assert.equal(replies[0].embeds[0].title, '自動監視一覧');
    for (const label of ['稼働中', '停止中', '初回確認待ち', '取得制限で待機中', '取得失敗・再試行待ち', '通知先: DM', 'Webhook #88', '<t:1800000000:R>', '<t:1800000030:R>']) assert.ok(text.includes(label), label);
    assert.match(text, /2 — 停止中[^]*?次回確認: —/);
    assert.doesNotMatch(text, /INTERNAL_SECRET_CODE|undefined/);
    assert.deepEqual(calls[0].params, ['owner']);
    assert.equal(calls[1].user, 'owner');
});

test('auto watch list localizes empty guidance and keeps large follow-up pages private', async () => {
    let empty;
    await loadList([], [])({ locale: 'ja', user: { id: 'owner' }, editReply: async value => { empty = value; } });
    assert.match(empty.embeds[0].description, /autoextract watch/);
    const pages = [];
    await loadList([{ id: '9', twitter_username: 'legacy_user', webhook_endpoint_id: 10 }],
        Array.from({ length: 80 }, (_, i) => ({ id: String(i), providerId: 'github', enabled: true, sourceUrl: 'https://github.com/fixture', destinationType: 'dm' })))({
        locale: 'en-US', user: { id: 'owner' }, editReply: async value => pages.push(value), followUp: async value => pages.push(value),
    });
    assert.ok(pages.length > 1);
    assert.ok(pages.every(page => page.embeds[0].description.length <= 4096));
    assert.ok(pages.slice(1).every(page => page.ephemeral === true));
    const all = pages.map(page => page.embeds[0].description).join('\n');
    assert.match(all, /Waiting for first check/);
    assert.match(all, /existing registration; new registrations paused/);
    assert.doesNotMatch(all, /NaN|undefined/);
});
