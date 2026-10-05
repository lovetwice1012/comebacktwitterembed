'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const cards = require('../../src/personalLinks/cards');
const load = require('./helpers/load-dashboard.cjs');
const step = () => ({ embeds: [{ title: 'Item' }], restockOptions: [{ id: '1', name: 'Red' }] });
const context = visibility => ({ providerId: 'booth', url: 'https://booth.pm/ja/items/123', personalActions: true,
    presentationSettings: { button_invisible: visibility } });

test('personal action buttons respect independent hide flags without hiding other actions or media', async () => {
    for (const action of ['save', 'remind', 'restock']) {
        const original = step(); let saved = 0;
        const result = await cards.prepare(original, { guildId: 'g' }, context({ [`personal_${action}`]: true }), { saveCard: async () => saved++ });
        assert.equal(saved, 1);
        const ids = result.step.components.flatMap(row => row.components).map(button => button.custom_id.split(':')[1]);
        assert.equal(ids.length, 2); assert(!ids.includes(action));
        assert.deepEqual(result.step.embeds, original.embeds); assert.equal(original.components, undefined);
    }
});

test('hidden personal actions do not allocate cards and partial visibility reuses the remaining button row capacity', async () => {
    for (const visibility of [{ all: true }, { personal: true }, { personal_save: true, personal_remind: true, personal_restock: true }]) {
        const original = step();
        const result = await cards.prepare(original, { guildId: 'g' }, context(visibility), { saveCard: async () => assert.fail('hidden buttons must not write cards') });
        assert.strictEqual(result.step, original);
    }
    const original = { ...step(), components: [{ type: 1, components: Array.from({ length: 4 }, (_, i) => ({ type: 2, custom_id: `existing:${i}` })) }] };
    const result = await cards.prepare(original, { guildId: 'g' }, context({ personal_remind: true, personal_restock: true }), { saveCard: async () => {} });
    assert.equal(result.step.components.length, 1); assert.equal(result.step.components[0].components.length, 5);
    assert.equal(original.components[0].components.length, 4);
});

test('final dispatcher filtering understands personal action IDs and global all includes link buttons', async () => {
    const filename = require.resolve('../../src/settings'); const actualRequire = createRequire(filename), mod = { exports: {} };
    let visibility = { personal_save: true };
    compileFunction(readFileSync(filename, 'utf8'), ['require', 'module', 'exports', '__dirname'], { filename })(
        id => id === './providers/_provider_settings' ? { getSetting: async () => visibility } : actualRequire(id), mod, mod.exports, require('node:path').dirname(filename));
    const rows = () => [{ type: 1, components: [{ type: 2, custom_id: 'personal:save:abc' }, { type: 2, custom_id: 'personal:remind:abc' }, { type: 2, url: 'https://example.test/' }] }];
    const filtered = await mod.exports.checkComponentIncludesDisabledButtonAndIfFindDeleteIt(rows(), 'g', 'booth');
    assert.equal(filtered[0].components.length, 2);
    visibility = { all: true };
    assert.deepEqual(await mod.exports.checkComponentIncludesDisabledButtonAndIfFindDeleteIt(rows(), 'g', 'booth'), []);
});

test('Web preview applies the separate notice and unified button settings independently', () => {
    const { buildPreview } = load('lib/settings-preview.ts');
    const states = values => Object.entries(values).map(([key, value]) => ({ key, value }));
    const preview = buildPreview('booth', states({ show_previous_shares: false, button_invisible: { personal_save: true } }));
    assert.equal(preview.previousShareNotice, null); assert(!preview.buttons.some(b => b.key === 'personal_save'));
    assert(preview.buttons.some(b => b.key === 'personal_remind')); assert(preview.buttons.some(b => b.key === 'personal_restock'));
    assert(buildPreview('booth', []).previousShareNotice);
    assert(!buildPreview('instagram', states({ gallery_display_mode: 'gallery', button_invisible: { gallery: true } })).gallery);
    assert.equal(buildPreview('booth', states({ button_invisible: { all: true } })).buttons.length, 0);
});
