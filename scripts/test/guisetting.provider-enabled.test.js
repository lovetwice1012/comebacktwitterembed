'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const providerSettingsPath = require.resolve('../../src/providers/_provider_settings');

let enabled = false;

require.cache[providerSettingsPath] = {
    id: providerSettingsPath,
    filename: providerSettingsPath,
    loaded: true,
    exports: {
        getSetting: async () => undefined,
        isProviderEnabled: async () => enabled,
        setProviderEnabled: async (_provider, _guildId, value) => {
            enabled = value === true;
        },
        setSetting: async () => {},
    },
};

const guisetting = require('../../src/commands/handlers/guisetting');

function componentIds(payload) {
    return payload.components.flatMap(row => row.components.map(component => component.data.custom_id));
}

function componentById(payload, customId) {
    return payload.components.flatMap(row => row.components).find(component => component.data.custom_id === customId);
}

test('guisetting provider enabled renders enable and disable buttons', async () => {
    enabled = false;

    const payload = await guisetting._internal.buildGuiPayload('pixiv', 'enabled', 'guild-provider-enabled');
    const ids = componentIds(payload);

    assert.ok(ids.includes('guisetting:bool:pixiv:enabled:1'));
    assert.ok(ids.includes('guisetting:bool:pixiv:enabled:0'));

    assert.equal(componentById(payload, 'guisetting:bool:pixiv:enabled:1').data.disabled, false);
    assert.equal(componentById(payload, 'guisetting:bool:pixiv:enabled:0').data.disabled, true);
});

test('guisetting provider enabled buttons update provider state', async () => {
    enabled = false;
    let editedPayload = null;
    const interaction = {
        customId: 'guisetting:bool:pixiv:enabled:1',
        guildId: 'guild-provider-enabled',
        locale: 'en-US',
        replied: false,
        deferred: false,
        memberPermissions: { has: () => true },
        deferUpdate: async () => {
            interaction.deferred = true;
        },
        editReply: async (payload) => {
            editedPayload = payload;
        },
    };

    assert.equal(await guisetting.handleComponent(interaction), true);
    assert.equal(enabled, true);

    assert.equal(componentById(editedPayload, 'guisetting:bool:pixiv:enabled:1').data.disabled, true);
    assert.equal(componentById(editedPayload, 'guisetting:bool:pixiv:enabled:0').data.disabled, false);
});
