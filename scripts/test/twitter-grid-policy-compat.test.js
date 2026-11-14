'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cards = require('../../src/twitterGridCards');

function policy() {
    return { enabled: true, defaultLanguage: 'ja', silent_expansion: false, show_previous_shares: true,
        editOriginalIfTranslate: false, non_nsfw_channel_sensitive_restriction_enabled: true,
        sensitive_content_excluded_targets: { user: [], role: [], channel: [] },
        button_disabled: { user: [], role: [], channel: [] }, button_invisible: {},
        hidden_output_items: [], media_display_mode: 'embed', secondary_extract_mode: false,
        secondary_extract_mode_multiple_images: true, secondary_extract_mode_video: true,
        twitter_grid_columns: 2 };
}

test('legacy records prove harmless preference changes without rewriting stored hashes', () => {
    const original = policy(), payload = { settingsHash: cards.safetyHash(original) };
    const saved = JSON.stringify(payload);
    const current = { ...original, defaultLanguage: 'en-US', silent_expansion: true,
        show_previous_shares: false, editOriginalIfTranslate: true, twitter_grid_columns: 8 };
    assert.equal(cards.matchesSafetyPolicy(current, payload), true);
    assert.equal(JSON.stringify(payload), saved);
    assert.equal(cards.matchesSafetyPolicy(current, payload), true, 'cached proof yields the same result');
});

test('new records permit harmless preferences but keep all other policy fields protected', async () => {
    const original = policy(), imageUrls = ['https://pbs.twimg.com/media/one.jpg', 'https://pbs.twimg.com/media/two.jpg'];
    let stored;
    const storage = { save: async payload => { stored = payload; } };
    await cards.prepare({ twitterGrid: { imageUrls, sequence: 0, totalParts: 1 }, components: [] },
        { guildId: '111111111111111111', channelId: '222222222222222222', author: { id: '333333333333333333' } },
        { providerId: 'twitter', presentationSettings: original }, storage);
    assert.equal(stored.settingsHash, cards.safetyHash(original));
    assert.equal(stored.settingsPolicyHash, cards.safetyPolicyHash(original));
    const changed = { ...original, defaultLanguage: 'en-US', silent_expansion: true,
        show_previous_shares: false, editOriginalIfTranslate: true };
    assert.equal(cards.matchesSafetyPolicy(changed, stored), true);
    assert.notEqual(cards.safetyHash(changed), stored.settingsHash);
    for (const mutate of [
        { enabled: false }, { media_display_mode: 'link_only' }, { hidden_output_items: ['media'] },
        { non_nsfw_channel_sensitive_restriction_enabled: false }, { secondary_extract_mode: true },
        { sensitive_content_excluded_targets: { user: [], role: [], channel: ['999999999999999999'] } },
        { button_disabled: { user: [], role: ['888888888888888888'], channel: [] } },
        { button_invisible: { tg: true } }, { future_safety_setting: true },
    ]) assert.equal(cards.matchesSafetyPolicy({ ...changed, ...mutate }, stored), false, JSON.stringify(mutate));
});

test('legacy candidate proof never ignores safety, unknown fields, corrupt hashes, or oversized inputs', () => {
    const original = policy(), payload = { settingsHash: cards.safetyHash(original) };
    const changed = { ...original, defaultLanguage: 'en-US', silent_expansion: true };
    for (const mutate of [
        { enabled: false }, { media_display_mode: 'thumbnail_only' }, { hidden_output_items: ['media'] },
        { non_nsfw_channel_sensitive_restriction_enabled: false },
        { button_disabled: { user: ['999999999999999999'], role: [], channel: [] } },
        { sensitive_content_excluded_targets: { user: [], role: ['888888888888888888'], channel: [] } },
        { future_safety_setting: true },
    ]) assert.equal(cards.matchesSafetyPolicy({ ...changed, ...mutate }, payload), false, JSON.stringify(mutate));
    assert.equal(cards.matchesSafetyPolicy(changed, { settingsHash: 'x' }), false);
    assert.equal(cards.matchesSafetyPolicy(changed, { settingsHash: payload.settingsHash, settingsPolicyHash: 'x' }), false);
    const huge = { ...changed, bannedWords: ['x'.repeat(33000)] };
    assert.equal(cards.matchesSafetyPolicy(huge, { settingsHash: cards.safetyHash({ ...huge, defaultLanguage: 'ja' }) }), false);
});

test('legacy absence and legitimate locale aliases are proven rather than assumed', () => {
    const old = { enabled: true, defaultLanguage: 'en', hidden_output_items: [] };
    const next = { ...old, defaultLanguage: 'ja', silent_expansion: false, show_previous_shares: true, editOriginalIfTranslate: false };
    assert.equal(cards.matchesSafetyPolicy(next, { settingsHash: cards.safetyHash(old) }), true);
    assert.equal(cards.matchesSafetyPolicy({ ...next, hidden_output_items: ['media'] }, { settingsHash: cards.safetyHash(old) }), false);
});
