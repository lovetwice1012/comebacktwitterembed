'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

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
