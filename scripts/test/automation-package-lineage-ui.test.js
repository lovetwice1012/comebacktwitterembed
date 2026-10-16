'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const { newWorkflow } = require('../../src/automation/schema');
const tick = f => f.act(async () => new Promise(resolve => setTimeout(resolve, 25)));
const metadata = (packageId, license, description) => ({ packageId, version: 1, checksum: 'a'.repeat(64), license, description });
const dictionary = name => ({ schemaVersion: 1, name, mode: 'contains', source: 'Inner author', license: 'CC0-1.0', entries: ['alpha'] });
const dependencies = { dictionaries: { one: [metadata('11111111-1111-4111-8111-111111111111', 'CC-BY-SA-4.0', 'First outer author attribution')], two: [metadata('22222222-2222-4222-8222-222222222222', 'GPL-3.0-only', 'Second outer author attribution')] } };
const bundle = { schemaVersion: 1, kind: 'workflow', workflow: newWorkflow('Authored wrapper'), dictionaries: { one: dictionary('First dictionary'), two: dictionary('Second dictionary') } };
const pack = { id: 'package', title: 'Published wrapper', version: 1, latest_version: 1, status: 'active', packageStatus: 'active', packageVisibility: 'public', visibility: 'public', kind: 'workflow', mine: false, dependencies, bundle: { ...bundle, license: 'MIT' } };
test('all dictionary package licenses and source notices are available in the source preview and published package', async () => {
    const f = await reactFixture('export { MarketplaceManager } from "./components/automation/marketplace-manager";');
    try {
        const writes = [];
        const api = async (route, method = 'GET', body) => {
            if (route === 'starter') return null;
            if (route.startsWith('marketplace?')) return { items: [pack], nextCursor: null };
            if (route === 'workflows/source/export') return bundle;
            if (route === 'workflows/source/publication-export') return { bundle, dependencies };
            if (route === 'marketplace/package/open') return pack;
            if (route === 'marketplace' && method === 'POST') { writes.push(body); return { id: 'package', version: 1, status: 'draft' }; }
            assert.fail(route);
        };
        await f.render(f.React.createElement(f.exports.MarketplaceManager, { api, scope: 'private', canEdit: true, rules: [{ id: 'source', name: 'Authored wrapper' }], dictionaries: [], refresh: async () => {}, openRule: async () => {} })); await tick(f);
        await f.fill(f.field('対象'), 'source'); await f.click('共有元のライセンス・出典を確認');
        for (const text of ['First dictionary', 'Second dictionary', 'CC-BY-SA-4.0', 'GPL-3.0-only', 'First outer author attribution', 'Second outer author attribution']) assert(f.container.textContent.includes(text), text);
        assert.equal(writes.length, 0); await f.fill(f.field('名前'), 'Authored workflow wrapper'); await f.fill(f.field('ライセンス'), 'MIT'); await f.click('下書きを保存');
        assert.equal(writes[0].bundle.license, 'MIT'); assert.equal(writes[0].bundle.dependencies, undefined); assert.equal(writes[0].sourceWorkflowId, 'source');
        const details = [...f.container.querySelectorAll('summary')].filter(row => row.textContent === '辞書のライセンス・出典'); assert(details.length >= 1);
        for (const text of ['CC-BY-SA-4.0', 'GPL-3.0-only', 'First outer author attribution', 'Second outer author attribution']) assert(f.container.textContent.includes(text));
    } finally { await f.close(); }
});

for (const kind of ['workflow', 'dictionary']) for (const failed of [false, true]) test(`a delayed ${kind} source preview ${failed ? 'error' : 'response'} cannot restore credits or consent from an older displayed revision`, async () => {
    const f = await reactFixture('export { MarketplaceManager } from "./components/automation/marketplace-manager";');
    try {
        let release; let previews = 0;
        const info = text => ({ bundle, dependencies: { dictionaries: { one: [metadata('11111111-1111-4111-8111-111111111111', 'CC-BY-SA-4.0', text)] } } });
        const api = async route => {
            if (route === 'starter') return null;
            if (route.startsWith('marketplace?')) return { items: [], nextCursor: null };
            if (route.includes('/publication-export') || route.includes('/package-export?')) {
                previews++;
                return previews === 1 ? new Promise((resolve, reject) => { release = () => failed ? reject(new Error('Obsolete source error')) : resolve(info('Obsolete source credits')); }) : info('Current source credits');
            }
            assert.fail(route);
        };
        const props = revision => ({ api, scope: 'private', canEdit: true, rules: [{ id: 'source', name: 'Selected rule', revision }], dictionaries: [{ id: 'source', name: 'Selected dictionary', revision }], refresh: async () => {}, openRule: async () => {} });
        await f.render(f.React.createElement(f.exports.MarketplaceManager, props(1))); await tick(f);
        if (kind === 'dictionary') await f.fill(f.field('共有する内容'), 'dictionary');
        await f.fill(f.field('対象'), 'source');
        await f.fill(f.field('公開範囲'), 'public');
        const consent = [...f.container.querySelectorAll('input[type=checkbox]')].find(row => row.parentElement.textContent.includes('内容・再配布'));
        assert(consent); await f.act(async () => consent.click()); assert.equal(consent.checked, true);
        await f.click('共有元のライセンス・出典を確認');
        await f.render(f.React.createElement(f.exports.MarketplaceManager, props(2)));
        await f.act(async () => release()); await tick(f);
        assert(!f.container.textContent.includes('Obsolete source credits'));
        assert(!f.container.textContent.includes('Obsolete source error'));
        assert.equal(consent.checked, false);
        await f.click('共有元のライセンス・出典を確認');
        assert(f.container.textContent.includes('Current source credits'));
        assert.equal(previews, 2);
    } finally { await f.close(); }
});
