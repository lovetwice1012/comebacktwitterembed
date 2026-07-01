'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Locale } = require('discord.js');

const { buildSlashCommands } = require('../../src/commands');
const { loadProviders } = require('../../src/providers/_loader');
const { missingCatalogKeys, SUPPORTED_LOCALES } = require('../../src/i18n');

const providerSettingsPath = require.resolve('../../src/providers/_provider_settings');
const guisettingPath = require.resolve('../../src/commands/handlers/guisetting');

function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function settingKey(providerId, guildId, key) {
    return `${providerId}\0${guildId}\0${key}`;
}

function loadGuisettingWithFakeProviderSettings() {
    const originalGuisetting = require.cache[guisettingPath];
    const originalProviderSettings = require.cache[providerSettingsPath];
    const values = new Map();

    const getSetting = async (provider, key, guildId) => clone(values.get(settingKey(provider.id, guildId, key)));
    const isProviderEnabled = async (provider, guildId) => {
        const value = values.get(settingKey(provider.id, guildId, 'enabled'));
        return value === undefined ? provider.enabledByDefault === true : value === true;
    };

    require.cache[providerSettingsPath] = {
        id: providerSettingsPath,
        filename: providerSettingsPath,
        loaded: true,
        exports: {
            getSetting,
            setSetting: async (provider, key, guildId, value) => {
                values.set(settingKey(provider.id, guildId, key), clone(value));
            },
            isProviderEnabled,
            setProviderEnabled: async (provider, guildId, value) => {
                values.set(settingKey(provider.id, guildId, 'enabled'), value === true);
            },
        },
    };
    delete require.cache[guisettingPath];

    return {
        getSetting,
        guisetting: require(guisettingPath),
        isProviderEnabled,
        restore: () => {
            delete require.cache[guisettingPath];
            if (originalGuisetting) require.cache[guisettingPath] = originalGuisetting;
            if (originalProviderSettings) require.cache[providerSettingsPath] = originalProviderSettings;
            else delete require.cache[providerSettingsPath];
        },
    };
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

test('guisetting payload renders provider and setting controls', async () => {
    const { guisetting, restore } = loadGuisettingWithFakeProviderSettings();

    try {
        const payload = await guisetting._internal.buildGuiPayload('twitter', 'overview', 'guild-gui');

        assert.equal(payload.embeds[0].title, 'GUI Settings - Twitter / X');
        assert.equal(payload.components.length, 4);
        assert.equal(payload.components[0].components[0].data.custom_id, 'guisetting:provider:overview');
        assert.ok(payload.components[0].components[0].options.some(option => option.data.value === 'booth'));
        assert.ok(payload.components[0].components[0].options.some(option => option.data.value === 'tiktok'));
        assert.ok(payload.components[0].components[0].options.some(option => option.data.value === 'youtube'));
        assert.equal(payload.components[1].components[0].data.custom_id, 'guisetting:setting:twitter');
        assert.equal(payload.components[2].components[0].data.custom_id, 'guisetting:setting:twitter:1');
    } finally {
        restore();
    }
});

test('guisetting default language accepts every Discord locale through modal input', async () => {
    const { getSetting, guisetting, restore } = loadGuisettingWithFakeProviderSettings();
    const guildId = 'guild-gui-default-language';

    try {
        const payload = await guisetting._internal.buildGuiPayload('twitter', 'defaultLanguage', guildId, null, 'en-US');
        const controls = payload.components.flatMap(row => row.components);

        assert.ok(controls.some(component => component.data?.custom_id === 'guisetting:modalOpen:defaultLanguage:twitter:defaultLanguage'));
        assert.equal(controls.some(component => component.data?.custom_id?.startsWith('guisetting:choice:twitter:defaultLanguage')), false);

        for (const locale of Object.values(Locale)) {
            await guisetting._internal.applyDefaultLanguageInput('twitter', 'defaultLanguage', guildId, locale, 'en-US');
            assert.equal(await getSetting({ id: 'twitter' }, 'defaultLanguage', guildId), locale);
        }

        await guisetting._internal.applyDefaultLanguageInput('twitter', 'defaultLanguage', guildId, 'EN', 'en-US');
        assert.equal(await getSetting({ id: 'twitter' }, 'defaultLanguage', guildId), 'en-US');
    } finally {
        restore();
    }
});

test('guisetting payload renders Japanese UI', async () => {
    const { guisetting, restore } = loadGuisettingWithFakeProviderSettings();

    try {
        const payload = await guisetting._internal.buildGuiPayload('twitter', 'overview', 'guild-gui', null, 'ja');

    assert.equal(payload.embeds[0].title, 'GUI設定 - Twitter / X');
    assert.equal(payload.embeds[0].description, '編集する設定を選択してください。');
    assert.equal(payload.components[0].components[0].data.placeholder, 'プロバイダー');
    } finally {
        restore();
    }
});

test('guisetting explains which output area a provider setting changes', async () => {
    const { guisetting, restore } = loadGuisettingWithFakeProviderSettings();

    try {
        const payload = await guisetting._internal.buildGuiPayload('youtube', 'youtube_description_max_length', 'guild-gui', null, 'ja');
        const settingField = payload.embeds[0].fields[1];

        assert.ok(payload.embeds[0].description.includes('YouTube説明文の長さ'));
        assert.match(settingField.value, /YouTube/);
        assert.match(settingField.value, /説明文/);
    } finally {
        restore();
    }
});

test('guisetting output item hiding is separate from button hiding', async () => {
    const { guisetting, restore } = loadGuisettingWithFakeProviderSettings();

    try {
        const payload = await guisetting._internal.buildGuiPayload('github', 'hidden_output_items', 'guild-gui', null, 'ja');
        const settingField = payload.embeds[0].fields[1];

        assert.ok(payload.embeds[0].description.includes('非表示にする出力項目'));
        assert.match(settingField.value, /応答ボタン/);
        assert.ok(payload.components[2].components[0].data.custom_id.startsWith('guisetting:outputVisibility:github:hidden_output_items'));
        assert.notEqual(payload.components[2].components[0].data.custom_id.includes('buttonVisibility'), true);
    } finally {
        restore();
    }
});

test('guisetting locale catalogs are complete for supported GUI locales', () => {
    assert.deepEqual([...SUPPORTED_LOCALES].sort(), Object.values(Locale).sort());
    assert.equal(SUPPORTED_LOCALES.includes('en'), false);
    assert.equal(SUPPORTED_LOCALES.includes('kr'), false);
    assert.ok(SUPPORTED_LOCALES.includes('ko'));
    assert.deepEqual(missingCatalogKeys('gui'), []);
});

test('guisetting covers every setting exposed by /settings', () => {
    const { guisetting, restore } = loadGuisettingWithFakeProviderSettings();
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
            'display_density',
            'media_display_mode',
            'twitter_stats_layout',
            'twitter_text_mode',
            'twitter_quote_mode',
            'twitter_quote_layout',
            'hidden_output_items',
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
            'anonymous_expand',
            'alwaysreplyifpostedtweetlink',
            'deletemessageifonlypostedtweetlink',
            'legacy_mode',
            'display_density',
            'media_display_mode',
            'pixiv_images_per_step',
            'pixiv_caption_max_length',
            'pixiv_tag_limit',
            'hidden_output_items',
        ],
        youtube: [
            'enabled',
            'disable',
            'defaultLanguage',
            'editOriginalIfTranslate',
            'extract_bot_message',
            'button_invisible',
            'button_disabled',
            'anonymous_expand',
            'alwaysreplyifpostedtweetlink',
            'deletemessageifonlypostedtweetlink',
            'display_density',
            'media_display_mode',
            'youtube_video_list_limit',
            'youtube_description_max_length',
            'hidden_output_items',
        ],
        instagram: [
            'enabled',
            'disable',
            'defaultLanguage',
            'editOriginalIfTranslate',
            'extract_bot_message',
            'button_invisible',
            'button_disabled',
            'anonymous_expand',
            'alwaysreplyifpostedtweetlink',
            'deletemessageifonlypostedtweetlink',
            'display_density',
            'media_display_mode',
            'instagram_caption_max_length',
            'instagram_media_limit',
            'hidden_output_items',
        ],
        tiktok: [
            'enabled',
            'disable',
            'defaultLanguage',
            'editOriginalIfTranslate',
            'extract_bot_message',
            'button_invisible',
            'button_disabled',
            'anonymous_expand',
            'alwaysreplyifpostedtweetlink',
            'deletemessageifonlypostedtweetlink',
            'tiktok_hq',
            'display_density',
            'media_display_mode',
            'tiktok_description_max_length',
            'tiktok_image_limit',
            'tiktok_video_fallback_mode',
            'hidden_output_items',
        ],
        niconico: [
            'enabled',
            'disable',
            'defaultLanguage',
            'editOriginalIfTranslate',
            'extract_bot_message',
            'button_invisible',
            'button_disabled',
            'anonymous_expand',
            'alwaysreplyifpostedtweetlink',
            'deletemessageifonlypostedtweetlink',
            'display_density',
            'media_display_mode',
            'niconico_description_max_length',
            'hidden_output_items',
        ],
        spotify: [
            'enabled',
            'disable',
            'defaultLanguage',
            'editOriginalIfTranslate',
            'extract_bot_message',
            'button_invisible',
            'button_disabled',
            'anonymous_expand',
            'alwaysreplyifpostedtweetlink',
            'deletemessageifonlypostedtweetlink',
            'legacy_mode',
            'display_density',
            'media_display_mode',
            'spotify_description_max_length',
            'hidden_output_items',
        ],
        twitch: [
            'enabled',
            'disable',
            'defaultLanguage',
            'editOriginalIfTranslate',
            'extract_bot_message',
            'button_invisible',
            'button_disabled',
            'anonymous_expand',
            'alwaysreplyifpostedtweetlink',
            'deletemessageifonlypostedtweetlink',
            'legacy_mode',
            'display_density',
            'media_display_mode',
            'twitch_description_max_length',
            'hidden_output_items',
        ],
        github: [
            'enabled',
            'disable',
            'defaultLanguage',
            'editOriginalIfTranslate',
            'extract_bot_message',
            'button_invisible',
            'button_disabled',
            'bannedWords',
            'anonymous_expand',
            'alwaysreplyifpostedtweetlink',
            'deletemessageifonlypostedtweetlink',
            'display_density',
            'media_display_mode',
            'github_card_style',
            'hidden_output_items',
        ],
        steam: [
            'enabled',
            'disable',
            'defaultLanguage',
            'editOriginalIfTranslate',
            'extract_bot_message',
            'button_invisible',
            'button_disabled',
            'bannedWords',
            'anonymous_expand',
            'alwaysreplyifpostedtweetlink',
            'deletemessageifonlypostedtweetlink',
            'display_density',
            'media_display_mode',
            'steam_description_max_length',
            'steam_image_source',
            'hidden_output_items',
        ],
        amazon: [
            'enabled',
            'disable',
            'defaultLanguage',
            'editOriginalIfTranslate',
            'extract_bot_message',
            'button_invisible',
            'button_disabled',
            'bannedWords',
            'anonymous_expand',
            'alwaysreplyifpostedtweetlink',
            'deletemessageifonlypostedtweetlink',
            'display_density',
            'media_display_mode',
            'amazon_description_max_length',
            'amazon_extract_targets',
            'hidden_output_items',
        ],
        booth: [
            'enabled',
            'disable',
            'defaultLanguage',
            'editOriginalIfTranslate',
            'extract_bot_message',
            'button_invisible',
            'button_disabled',
            'anonymous_expand',
            'alwaysreplyifpostedtweetlink',
            'deletemessageifonlypostedtweetlink',
            'legacy_mode',
            'display_density',
            'media_display_mode',
            'booth_description_max_length',
            'booth_image_limit',
            'booth_adult_display_mode',
            'hidden_output_items',
        ],
    };

    try {
        for (const [provider, expectedSpecs] of Object.entries(expectedSpecsByProvider)) {
            const actualSpecs = guisetting._internal.getSettingSpecs(provider).map(spec => spec.key);
            for (const expectedSpec of expectedSpecs) {
                assert.ok(actualSpecs.includes(expectedSpec), `${provider} is missing ${expectedSpec}`);
            }
        }
    } finally {
        restore();
    }
});

test('guisetting exposes provider enabled setting for every provider', () => {
    const { guisetting, restore } = loadGuisettingWithFakeProviderSettings();

    try {
        for (const provider of loadProviders()) {
            const actualSpecs = guisetting._internal.getSettingSpecs(provider.id).map(spec => spec.key);
            assert.ok(actualSpecs.includes('enabled'), `${provider.id} is missing enabled`);
        }
    } finally {
        restore();
    }
});

test('guisetting exposes failure display policy for every provider', () => {
    const { guisetting, restore } = loadGuisettingWithFakeProviderSettings();

    try {
        for (const provider of loadProviders()) {
            const actualSpecs = guisetting._internal.getSettingSpecs(provider.id).map(spec => spec.key);
            assert.ok(actualSpecs.includes('failure_display_policy'), `${provider.id} is missing failure_display_policy`);
        }
    } finally {
        restore();
    }
});

test('guisetting keeps legacy and secondary modes exclusive', async () => {
    const { getSetting, guisetting, restore } = loadGuisettingWithFakeProviderSettings();
    const guildId = 'guild-gui-exclusive';

    try {
        await guisetting._internal.applySettingValue('twitter', 'secondary_extract_mode', guildId, true);
        assert.equal(await getSetting({ id: 'twitter' }, 'secondary_extract_mode', guildId), true);
        assert.equal(await getSetting({ id: 'twitter' }, 'legacy_mode', guildId), false);

        await guisetting._internal.applySettingValue('twitter', 'legacy_mode', guildId, true);
        assert.equal(await getSetting({ id: 'twitter' }, 'legacy_mode', guildId), true);
        assert.equal(await getSetting({ id: 'twitter' }, 'secondary_extract_mode', guildId), false);
    } finally {
        restore();
    }
});

test('guisetting toggles provider enabled state', async () => {
    const { guisetting, isProviderEnabled, restore } = loadGuisettingWithFakeProviderSettings();
    const guildId = 'guild-gui-provider-enabled';

    try {
        await guisetting._internal.applySettingValue('pixiv', 'enabled', guildId, true);
        assert.equal(await isProviderEnabled({ id: 'pixiv', enabledByDefault: false }, guildId), true);

        await guisetting._internal.applySettingValue('pixiv', 'enabled', guildId, false);
        assert.equal(await isProviderEnabled({ id: 'pixiv', enabledByDefault: false }, guildId), false);
    } finally {
        restore();
    }
});

test('guisetting banned word form toggles a word', async () => {
    const { getSetting, guisetting, restore } = loadGuisettingWithFakeProviderSettings();
    const guildId = 'guild-gui-bannedwords';

    try {
        assert.equal(
            await guisetting._internal.applyBannedWordInput('twitter', guildId, 'blocked'),
            'Added banned word: blocked'
        );
        assert.deepEqual(await getSetting({ id: 'twitter' }, 'bannedWords', guildId), ['blocked']);

        assert.equal(
            await guisetting._internal.applyBannedWordInput('twitter', guildId, 'blocked'),
            'Removed banned word: blocked'
        );
        assert.deepEqual(await getSetting({ id: 'twitter' }, 'bannedWords', guildId), []);
    } finally {
        restore();
    }
});
