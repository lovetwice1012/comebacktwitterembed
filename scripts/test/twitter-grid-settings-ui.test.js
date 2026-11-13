'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const loadDashboard = require('./helpers/load-dashboard.cjs');

test('the real settings catalog and form do not expose internal X image setting keys', async () => {
    const catalog = loadDashboard('lib/settings-catalog.ts');
    const { settings: specs } = catalog.getProviderCatalog('twitter');
    const gridSpecs = specs.filter(spec => spec.key.startsWith('twitter_grid_'));
    assert.equal(gridSpecs.length, 9);
    for (const spec of gridSpecs) assert.deepEqual(spec.description, { en: '', ja: '' }, spec.key);
    // A regular setting still retains its existing helpful description.
    const enabled = specs.find(spec => spec.key === 'enabled');
    assert.ok(enabled.description.ja);
    const defaults = catalog.getProviderDefaults();
    const rows = gridSpecs.map(spec => ({ key: spec.key, kind: spec.kind, value: defaults[spec.key], warnings: [], spec }));
    const f = await reactFixture('export { ProviderSettingsForm } from "./components/settings/provider-settings-form";');
    try {
        await f.render(f.React.createElement(f.exports.ProviderSettingsForm, {
            guildId: '111111', providerId: 'twitter', providerLabel: 'Twitter', canEdit: true, locale: 'ja', settings: rows,
            onSaveChanges: async () => {},
        }));
        for (const row of rows) {
            const card = f.container.querySelector(`[id="setting-${row.key}"]`);
            assert.ok(card, row.key);
            assert.equal(card.textContent.includes(row.key), false, row.key);
        }
    } finally { await f.close(); }
});

test('other settings keep their fallback and explicit X image descriptions remain available', () => {
    const { __test } = loadDashboard('lib/settings-catalog.ts', {}, ['serializeSpec']);
    const regular = __test.serializeSpec({ key: 'custom_setting', kind: 'choice', label: 'Example', description: { en: '', ja: '' } });
    assert.deepEqual(regular.description, { en: 'custom_setting', ja: 'custom_setting' });
    const grid = __test.serializeSpec({ key: 'twitter_grid_custom', kind: 'choice', label: 'Example', description: { en: 'Visible', ja: '説明' } });
    assert.deepEqual(grid.description, { en: 'Visible', ja: '説明' });
});

test('server settings accept precise grid defaults and stop invalid values before saving', async () => {
    const f = await reactFixture('export { ProviderSettingsForm } from "./components/settings/provider-settings-form";');
    const spec = (key, label, value) => ({ key, kind: 'choice', value, warnings: [], spec: { key, kind: 'choice', category: 'basic', label: { ja: label, en: label }, description: { ja: '', en: '' }, choices: [] } });
    try {
        const writes = [];
        await f.render(f.React.createElement(f.exports.ProviderSettingsForm, {
            guildId: '111111', providerId: 'twitter', providerLabel: 'Twitter', canEdit: true, locale: 'ja',
            settings: [spec('twitter_grid_columns', 'グリッドの列数', 2), spec('twitter_grid_background', '背景色', '#000000')],
            onSaveChanges: async changes => { writes.push(changes); },
        }));
        const columns = f.container.querySelector('input[aria-label="グリッドの列数"]');
        const background = f.container.querySelector('input[aria-label="背景色"]');
        assert.equal(columns.type, 'number'); assert.equal(columns.min, '1'); assert.equal(columns.max, '20');
        await f.fill(columns, '21'); await f.settle();
        assert.equal(columns.getAttribute('aria-invalid'), 'true');
        assert.equal([...f.container.querySelectorAll('button')].find(button => button.textContent.trim() === '変更を保存').disabled, true);
        assert.ok([...f.container.querySelectorAll('button')].some(button => button.textContent.trim() === '入力内容を確認'));
        await f.fill(columns, '7'); await f.fill(background, '#12'); await f.settle();
        await f.click('入力内容を確認');
        await f.act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
        assert.equal(f.dom.window.document.activeElement, background);
        await f.fill(background, '#12abcd'); await f.settle();
        assert.equal(columns.getAttribute('aria-invalid'), 'false');
        await f.click('変更を保存');
        assert.deepEqual(writes, [{ twitter_grid_columns: '7', twitter_grid_background: '#12abcd' }]);
    } finally { await f.close(); }
});
