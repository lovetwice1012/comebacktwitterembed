'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const tick = f => f.act(async () => new Promise(resolve => setTimeout(resolve, 25)));
const D = '11111111-1111-4111-8111-111111111111', P = '22222222-2222-4222-8222-222222222222';
const dictionary = { schemaVersion: 1, name: 'Imported dictionary', mode: 'contains', source: 'Original author', license: 'CC0-1.0', entries: ['alpha'] };
const bundle = { schemaVersion: 1, kind: 'dictionary', dictionaries: { words: dictionary }, license: 'CC-BY-SA-4.0', description: 'Verified original package attribution' };
function pack() { return { id: P, title: 'Owned source package', description: '', category: 'general', kind: 'dictionary', version: 1, latest_version: 1, status: 'active', packageStatus: 'active', visibility: 'public', packageVisibility: 'public', mine: true, fork_of: null, bundle }; }
async function fixture({ hold = false, failed = false, mismatch = false } = {}) {
    const f = await reactFixture('export { MarketplaceManager } from "./components/automation/marketplace-manager";');
    const calls = []; let finish, originFailed = failed;
    const api = async (route, method = 'GET', body) => {
        calls.push({ route, method, body: body && structuredClone(body) });
        if (route === 'starter') return null;
        if (route.startsWith('marketplace?')) return { items: [pack()], nextCursor: null };
        if (route.includes('/package-export?')) {
            if (originFailed) throw Object.assign(new Error('この辞書の保存版の配布元を確認できません。内容は保持されています。'), { status: 409, code: 'DICTIONARY_ORIGIN_REVIEW_REQUIRED' });
            const value = { bundle, sourceDictionaryId: D, sourceDictionaryRevision: mismatch ? 8 : 7, sourcePackageId: P };
            return hold ? new Promise(resolve => { finish = () => resolve(value); }) : value;
        }
        if (route.endsWith('/open')) return pack();
        if (route === 'marketplace' || route === `marketplace/${P}`) return { id: P, version: 2, status: 'active' };
        assert.fail(route);
    };
    const props = { api, scope: 'private', canEdit: true, rules: [], dictionaries: [{ id: D, name: 'Imported dictionary', revision: 7 }], refresh: async () => {}, openRule: async () => {} };
    await f.render(f.React.createElement(f.exports.MarketplaceManager, props)); await tick(f);
    return Object.assign(f, { calls, props, finish: () => finish(), repair: () => { originFailed = false; } });
}
async function rights(f) { const checkbox = [...f.container.querySelectorAll('input[type=checkbox]')].find(node => node.parentElement.textContent.includes('内容・再配布')); assert(checkbox); await f.act(async () => checkbox.click()); }
async function fillSource(f) { await f.fill(f.field('共有する内容'), 'dictionary'); await f.fill(f.field('対象'), D); await f.fill(f.field('名前'), 'Retained dictionary publication'); }
const writes = f => f.calls.filter(row => (row.route === 'marketplace' || row.route === `marketplace/${P}`) && ['POST', 'PATCH'].includes(row.method));

test('dictionary publication freezes the displayed revision and uses the verified package bundle and source proof', async () => {
    const f = await fixture({ hold: true });
    try {
        await fillSource(f); assert([...f.field('対象').options].some(row => row.textContent.includes('版 7')));
        await f.fill(f.field('公開範囲'), 'public'); await rights(f); await f.click('公開する');
        await f.render(f.React.createElement(f.exports.MarketplaceManager, { ...f.props, dictionaries: [{ id: D, name: 'Imported dictionary', revision: 8 }] }));
        await f.act(async () => f.finish());
        assert(f.calls.some(row => row.route === `dictionaries/${D}/package-export?revision=7`)); assert.equal(writes(f).length, 1);
        assert.equal(writes(f)[0].body.sourceDictionaryId, D); assert.equal(writes(f)[0].body.sourceDictionaryRevision, 7); assert.equal(writes(f)[0].body.bundle.license, 'CC-BY-SA-4.0'); assert.equal(writes(f)[0].body.bundle.dictionaries.words.license, 'CC0-1.0'); assert.equal(writes(f)[0].body.sourcePackageId, undefined);
        assert(!f.calls.some(row => row.route.includes('/export?format=json')));
    } finally { await f.close(); }
});
test('unknown source editions and mismatched export revisions retain the composer and never submit a publication', async () => {
    for (const options of [{ failed: true }, { mismatch: true }]) {
        const f = await fixture(options);
        try {
            await fillSource(f); await f.click('下書きを保存'); assert.equal(writes(f).length, 0); assert.equal(f.field('名前').value, 'Retained dictionary publication'); assert.equal(f.field('対象').value, D);
            if (options.failed) { f.repair(); await f.click('下書きを保存'); assert.equal(writes(f).length, 1); assert.equal(writes(f)[0].body.sourceDictionaryRevision, 7); }
        } finally { await f.close(); }
    }
});
test('an original package author can revise its own imported dictionary source license without client origin fields', async () => {
    const f = await fixture();
    try {
        await f.act(async () => f.container.querySelector(`[data-package-id="${P}"]`).click()); await f.click('共有内容を改訂'); await fillSource(f); await f.fill(f.field('ライセンス'), 'MIT'); await rights(f); await f.click('公開する');
        assert.equal(writes(f).length, 1); assert.equal(writes(f)[0].method, 'PATCH'); assert.equal(writes(f)[0].body.expectedVersion, 1); assert.equal(writes(f)[0].body.sourceDictionaryRevision, 7); assert.equal(writes(f)[0].body.bundle.license, 'MIT'); assert.equal(writes(f)[0].body.sourcePackageId, undefined);
    } finally { await f.close(); }
});
