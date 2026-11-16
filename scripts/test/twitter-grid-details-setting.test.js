'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getProviderSettingSpecs } = require('../../src/providers/_setting_specs');
const settings = require('../../src/providers/_provider_settings');
const twitter = require('../../src/providers/twitter');

test('split X post details default to the final image and can be set to the first', () => {
    const spec = getProviderSettingSpecs(twitter).find(item => item.key === 'twitter_grid_details_position');
    assert.ok(spec);
    assert.equal(spec.kind, 'choice');
    assert.deepEqual(spec.choices.map(item => item.value), ['last', 'first']);
    assert.equal(settings._internal.settingDefault(twitter, spec.key), 'last');
    assert.equal(settings.PROVIDER_SETTING_COLUMNS[spec.key].column, spec.key);
});
