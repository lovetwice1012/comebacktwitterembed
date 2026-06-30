'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Locale } = require('discord.js');

const { buildSlashCommands } = require('../../src/commands');
const guisetting = require('../../src/commands/handlers/guisetting');
const { settings } = require('../../src/settings');
const { getSetting, isProviderEnabled } = require('../../src/providers/_provider_settings');
const { loadProviders } = require('../../src/providers/_loader');
const { missingCatalogKeys, SUPPORTED_LOCALES } = require('../../src/i18n');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

test('buildSlashCommands includes guisetting', () => {
    const commands = buildSlashCommands();
    const command = commands.find(item => item.name === 'guisetting');
    assert.ok(command);

    const data = command.toJSON ? command.toJSON() : command;
    assert.equal(data.name_localizations.en, undefined);
    assert.equal(data.name_localizations['en-US'], 'guisetting');
    assert.equal(data.name_localizations.kr, undefined);
    assert.equal(data.name_localizations.ko, 'guisetting');
});

test('guisetting payload renders provider and setting controls', () => {
    const payload = guisetting._internal.buildGuiPayload('twitter', 'overview', 'guild-gui');

    assert.equal(payload.embeds[0].title, 'GUI Settings - Twitter / X');
    assert.equal(payload.components.length, 3);
    assert.equal(payload.components[0].components[0].data.custom_id, 'guisetting:provider:overview');
    assert.ok(payload.components[0].components[0].options.some(option => option.data.value === 'booth'));
    assert.ok(payload.components[0].components[0].options.some(option => option.data.value === 'tiktok'));
    assert.ok(payload.components[0].components[0].options.some(option => option.data.value === 'youtube'));
    assert.equal(payload.components[1].components[0].data.custom_id, 'guisetting:setting:twitter');
});

test('guisetting payload renders Japanese UI', () => {
    const payload = guisetting._internal.buildGuiPayload('twitter', 'overview', 'guild-gui', null, 'ja');

    assert.equal(payload.embeds[0].title, 'GUI設定 - Twitter / X');
    assert.equal(payload.embeds[0].description, '編集する設定を選択してください。');
    assert.equal(payload.components[0].components[0].data.placeholder, 'プロバイダー');
});

test('guisetting locale catalogs are complete for supported GUI locales', () => {
    assert.deepEqual([...SUPPORTED_LOCALES].sort(), Object.values(Locale).sort());
    assert.equal(SUPPORTED_LOCALES.includes('en'), false);
    assert.equal(SUPPORTED_LOCALES.includes('kr'), false);
    assert.ok(SUPPORTED_LOCALES.includes('ko'));
    assert.deepEqual(missingCatalogKeys('gui'), []);
});

test('guisetting covers every setting exposed by /settings', () => {
    const expectedSpecsByProvider = {
        twitter: [
            'enabled',
            'disable',
            'defaultLanguage',
            'editOriginalIfTranslate',
            'extract_bot_message',
            'button_invisible',
            'button_disabled',
            'bannedWords',
            'sendMediaAsAttachmentsAsDefault',
            'deletemessageifonlypostedtweetlink',
            'deletemessageifonlypostedtweetlink_secoundaryextractmode',
            'alwaysreplyifpostedtweetlink',
            'anonymous_expand',
            'quote_repost_do_not_extract',
            'quote_repost_max_depth',
            'legacy_mode',
            'passive_mode',
            'secondary_extract_mode',
            'secondary_extract_mode_multiple_images',
            'secondary_extract_mode_video',
        ],
        pixiv: [
            'enabled',
            'disable',
            'defaultLanguage',
            'editOriginalIfTranslate',
            'extract_bot_message',
            'button_invisible',
            'button_disabled',
            'pixiv_images_per_step',
        ],
    };

    for (const [provider, expectedSpecs] of Object.entries(expectedSpecsByProvider)) {
        const actualSpecs = guisetting._internal.getSettingSpecs(provider).map(spec => spec.key);
        for (const expectedSpec of expectedSpecs) {
            assert.ok(actualSpecs.includes(expectedSpec), `${provider} is missing ${expectedSpec}`);
        }
    }
});

test('guisetting exposes provider enabled setting for every provider', () => {
    for (const provider of loadProviders()) {
        const actualSpecs = guisetting._internal.getSettingSpecs(provider.id).map(spec => spec.key);
        assert.ok(actualSpecs.includes('enabled'), `${provider.id} is missing enabled`);
    }
});

test('guisetting keeps legacy and secondary modes exclusive', () => {
    const guildId = 'guild-gui-exclusive';
    const original = {
        byProvider: clone(settings.byProvider),
        legacy_mode: clone(settings.legacy_mode),
        secondary_extract_mode: clone(settings.secondary_extract_mode),
    };

    try {
        guisetting._internal.applySettingValue('twitter', 'secondary_extract_mode', guildId, true);
        assert.equal(getSetting({ id: 'twitter' }, 'secondary_extract_mode', guildId), true);
        assert.equal(getSetting({ id: 'twitter' }, 'legacy_mode', guildId), false);

        guisetting._internal.applySettingValue('twitter', 'legacy_mode', guildId, true);
        assert.equal(getSetting({ id: 'twitter' }, 'legacy_mode', guildId), true);
        assert.equal(getSetting({ id: 'twitter' }, 'secondary_extract_mode', guildId), false);
    } finally {
        settings.byProvider = original.byProvider;
        settings.legacy_mode = original.legacy_mode;
        settings.secondary_extract_mode = original.secondary_extract_mode;
    }
});

test('guisetting toggles provider enabled state', () => {
    const guildId = 'guild-gui-provider-enabled';
    const original = clone(settings.byProvider);

    try {
        guisetting._internal.applySettingValue('pixiv', 'enabled', guildId, true);
        assert.equal(isProviderEnabled({ id: 'pixiv', enabledByDefault: false }, guildId), true);

        guisetting._internal.applySettingValue('pixiv', 'enabled', guildId, false);
        assert.equal(isProviderEnabled({ id: 'pixiv', enabledByDefault: false }, guildId), false);
    } finally {
        settings.byProvider = original;
    }
});

test('guisetting banned word form toggles a word', () => {
    const guildId = 'guild-gui-bannedwords';
    const original = {
        byProvider: clone(settings.byProvider),
        bannedWords: clone(settings.bannedWords),
    };

    try {
        assert.equal(
            guisetting._internal.applyBannedWordInput('twitter', guildId, 'blocked'),
            'Added banned word: blocked'
        );
        assert.deepEqual(getSetting({ id: 'twitter' }, 'bannedWords', guildId), ['blocked']);

        assert.equal(
            guisetting._internal.applyBannedWordInput('twitter', guildId, 'blocked'),
            'Removed banned word: blocked'
        );
        assert.deepEqual(getSetting({ id: 'twitter' }, 'bannedWords', guildId), []);
    } finally {
        settings.byProvider = original.byProvider;
        settings.bannedWords = original.bannedWords;
    }
});
