'use strict';

process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField } = require('discord.js');

const {
    maybeSendSettingsWebuiNotice,
    _internal,
} = require('../../src/commands/handlers/settings/webuiNotice');

beforeEach(() => {
    _internal.resetTestState();
});

function interaction(overrides = {}) {
    const followUps = [];
    return {
        guildId: 'guild-notice',
        locale: 'ja',
        user: { id: 'user-notice' },
        memberPermissions: new PermissionsBitField(PermissionsBitField.Flags.ManageGuild),
        followUps,
        followUp: async (payload) => {
            followUps.push(payload);
            return payload;
        },
        ...overrides,
    };
}

test('settings webui notice embed points to guild dashboard settings', () => {
    const embed = _internal.buildSettingsWebuiNoticeEmbed('12345', 'ja');

    assert.equal(embed.title, 'Web UIでもっと細かく設定できます');
    assert.equal(embed.url.endsWith('/dashboard/12345/settings'), true);
    assert.match(embed.description, /高度なカスタマイズ/);
    assert.match(embed.description, /サポートされなくなる予定/);
    assert.match(embed.fields[0].value, /サーバー設定Dashboard/);
});

test('settings webui notice is sent once for a guild with no webui usage', async () => {
    const first = interaction();
    const second = interaction();

    assert.equal(await maybeSendSettingsWebuiNotice(first), true);
    assert.equal(first.followUps.length, 1);
    assert.equal(first.followUps[0].ephemeral, true);
    assert.match(first.followUps[0].embeds[0].description, /コマンド未対応/);

    assert.equal(await maybeSendSettingsWebuiNotice(second), false);
    assert.equal(second.followUps.length, 0);
});

test('settings webui notice is skipped when webui usage already exists', async () => {
    _internal.markTestWebuiUsage('guild-notice');
    const i = interaction();

    assert.equal(await maybeSendSettingsWebuiNotice(i), false);
    assert.equal(i.followUps.length, 0);
});

test('settings webui notice requires settings permissions', async () => {
    const i = interaction({
        memberPermissions: new PermissionsBitField(0n),
    });

    assert.equal(await maybeSendSettingsWebuiNotice(i), false);
    assert.equal(i.followUps.length, 0);
});
