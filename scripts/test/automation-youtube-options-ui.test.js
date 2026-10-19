'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
async function fixture({ editing = false, providerId = 'youtube', options } = {}) {
    const f = await reactFixture('export { MonitorRegistration } from "./components/automation/monitor-registration"; export { rebaseMonitorDraft, monitorBehaviorChanged } from "./components/automation/monitor-edit-view";');
    const initial = { ...(editing ? { id: '1', revision: 1 } : {}), kind: 'auto', scope: 'private', name: 'millsage', providerId,
        source: 'https://www.youtube.com/@millsage_ofc', destinationId: 'dm', workflowId: '', enabled: true, locale: 'ja', ...(options ? { youtubeOptions: options } : {}) };
    f.saved = []; f.requests = [];
    function Wrapper() {
        const [draft, setDraft] = f.React.useState(initial); f.draft = draft;
        return f.React.createElement(f.exports.MonitorRegistration, { monitor: draft, original: editing ? initial : null, kind: 'auto', scope: 'private', busy: false,
            catalog: { autoRegistration: { eligible: true }, auto: [{ id: 'youtube' }, { id: 'github' }] },
            destinations: [{ id: 'dm', name: '自分のDM', kind: 'dm', scope: 'private', enabled: true }], rules: [],
            onChange: setDraft, onSourceChange: source => setDraft({ ...draft, source }), run: async work => work(), refresh: async () => {},
            onSave: async value => f.saved.push(value), api: async (route, method, body) => {
                f.requests.push({ route, method, body });
                assert.equal(route, 'monitors/auto/preview');
                return { providerId, source: body.source, intervalMinutes: 30 };
            } });
    }
    await f.render(f.React.createElement(Wrapper)); return f;
}
const check = (f, label) => [...f.container.querySelectorAll('label')].find(node => node.textContent.trim() === label)?.querySelector('input');
const toggle = async (f, label) => f.act(async () => check(f, label).dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })));

test('YouTube registration defaults to releases on/posts off; toggles survive review/back and save', async () => {
    const f = await fixture();
    try {
        await f.submit(); assert.equal(check(f, 'リリース').checked, true); assert.equal(check(f, 'コミュニティ投稿').checked, false);
        await toggle(f, 'リリース'); await toggle(f, 'コミュニティ投稿');
        await f.submit();
        const review = f.container.querySelector('[aria-label="保存する通知の確認"]');
        assert.match(review.textContent, /動画・ショート・配信、コミュニティ投稿/);
        await f.click('戻る'); assert.equal(check(f, 'リリース').checked, false); assert.equal(check(f, 'コミュニティ投稿').checked, true);
        await f.submit(); await f.submit();
        assert.equal(f.saved.length, 1); assert.deepEqual(f.saved[0].youtubeOptions, { releases: false, community: true });
        assert.equal(f.saved[0].destinationId, 'dm');
    } finally { await f.close(); }
});

test('existing YouTube options are editable and reviewed instead of being dropped as a label-only change', async () => {
    const f = await fixture({ editing: true });
    try {
        assert.equal(check(f, 'リリース').checked, true); assert.equal(check(f, 'コミュニティ投稿').checked, false);
        await toggle(f, 'コミュニティ投稿'); await f.submit();
        assert.equal(f.saved.length, 0); assert(f.container.querySelector('[aria-label="保存する通知の確認"]'));
        await f.submit(); assert.deepEqual(f.saved[0].youtubeOptions, { releases: true, community: true });
        assert.equal(f.requests.length, 0, 'Options-only edits do not need another URL preview');
        const latest = { ...f.draft, youtubeOptions: { releases: false, community: false }, revision: 2 };
        const merged = f.exports.rebaseMonitorDraft({ ...f.draft, youtubeOptions: { releases: true, community: false } }, f.draft, latest, 'auto');
        assert.deepEqual(merged.youtubeOptions, { releases: false, community: true }); assert.equal(merged.revision, 2);
    } finally { await f.close(); }
});

test('other services do not display YouTube controls', async () => {
    const f = await fixture({ editing: true, providerId: 'github' });
    try { assert.equal(check(f, 'リリース'), undefined); assert.equal(check(f, 'コミュニティ投稿'), undefined); }
    finally { await f.close(); }
});
