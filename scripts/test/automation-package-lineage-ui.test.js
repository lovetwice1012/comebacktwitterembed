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
