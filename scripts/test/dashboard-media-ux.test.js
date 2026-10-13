'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

test('shared media deletion is unavailable without administrator permission and names its all-server destructive scope', async () => {
    const f = await reactFixture('export { CleanupExpiredButton } from "./components/media/media-actions";');
    try {
        const writes = [], confirmations = [];
        f.set('fetch', async (...args) => { writes.push(args); return new Response('{}'); });
        f.set('confirm', text => { confirmations.push(text); return false; });
        await f.render(f.React.createElement(f.exports.CleanupExpiredButton, { guildId: 'guild', locale: 'ja', canClean: false }));
        assert.equal(f.container.querySelector('button').disabled, true);
        assert(f.container.textContent.includes('管理者権限'));
        await f.render(f.React.createElement(f.exports.CleanupExpiredButton, { guildId: 'guild', locale: 'ja', canClean: true }));
        await f.click('期限切れを削除');
        assert.equal(writes.length, 0);
        assert(confirmations[0].includes('全サーバー共通'));
        assert(confirmations[0].includes('元に戻せません'));
    } finally { await f.close(); }
});

test('shared media deletion exposes a denied or unconfirmed result, retries and refreshes only after confirmed success', async () => {
    let refreshes = 0;
    const f = await reactFixture('export { CleanupExpiredButton } from "./components/media/media-actions";', { moduleOverrides: { 'next/navigation': { useRouter: () => ({ refresh() { refreshes++; } }) } } });
    try {
        let state = 'denied';
        f.set('confirm', () => true);
        f.set('fetch', async () => state === 'denied' ? new Response(JSON.stringify({ error: 'private-db-secret' }), { status: 403 }) : state === 'uncertain' ? new Response('{}') : new Response(JSON.stringify({ cleanup: { twitter: 2, pixiv: 1 } })));
        await f.render(f.React.createElement(f.exports.CleanupExpiredButton, { guildId: 'guild', locale: 'ja', canClean: true }));
        await f.click('期限切れを削除');
        assert.equal(refreshes, 0); assert(f.container.querySelector('[role="alert"]'));
        assert(!f.container.textContent.includes('private-db-secret'));
        state = 'uncertain'; await f.click('期限切れを削除');
        assert.equal(refreshes, 0); assert(f.container.textContent.includes('削除結果を確認できません'));
        state = 'ok'; await f.click('期限切れを削除');
        assert.equal(refreshes, 1); assert(f.container.querySelector('[role="status"]').textContent.includes('3件'));
    } finally { await f.close(); }
});
