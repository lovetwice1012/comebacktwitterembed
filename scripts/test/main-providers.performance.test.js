'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    baselineCursorModel, cursorCases, extractFixture, githubCases, githubFixture, loadVersions,
} = require('../benchmark_main_providers');

// Set MAIN_PROVIDERS_BASELINE_DIR to compare the captured pre-task source too.
// Normal CI needs no external snapshot; explicit expectations below supplement
// the compact baseline models retained by the reproducible benchmark.
const { before, after } = loadVersions(process.env.MAIN_PROVIDERS_BASELINE_DIR);

for (const scenario of githubCases()) {
    test(`provider performance: GitHub output equivalence / ${scenario.name}`, async () => {
        const settingsBefore = structuredClone(scenario.settings);
        const previous = await extractFixture(before.createGitHubClient, scenario.settings);
        const current = await extractFixture(after.createGitHubClient, scenario.settings);
        assert.deepEqual(current.output, previous.output);
        assert.deepEqual(scenario.settings, settingsBefore);
        assert.equal(previous.requests.length, 5);
        assert.equal(current.requests.length, scenario.expectedRequests);
        assert.equal(current.requests[0].url, 'https://api.github.com/repos/owner/repo');
        if (scenario.name === 'default-generated') {
            const step = current.output[0];
            assert.equal(step.embeds[0].image.url, 'attachment://github-repo-card-owner_repo.png');
            assert.equal(step.files.length, 1);
            assert.equal(step.files[0].attachment.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
            assert.equal(step.embeds[0].fields.find(field => field.name === 'Languages').value, 'JavaScript 80%, CSS 20%');
            assert.equal(step.embeds[0].fields.find(field => field.name === 'Language').value, 'JavaScript');
        }
    });
}

for (const fixtureOptions of [{ statsUnavailable: true }, { avatarFallback: true }]) {
    test(`provider performance: generated GitHub fallback equivalence / ${JSON.stringify(fixtureOptions)}`, async () => {
        const previous = await extractFixture(before.createGitHubClient, {}, fixtureOptions);
        const current = await extractFixture(after.createGitHubClient, {}, fixtureOptions);
        assert.deepEqual(current.output, previous.output);
        assert.deepEqual(current.requests, previous.requests);
        assert.equal(current.requests.length, fixtureOptions.avatarFallback ? 6 : 5);
    });
}

test('provider performance: GitHub gates use current settings on every call without cached omissions', async () => {
    const fixture = githubFixture();
    const client = after.createGitHubClient(fixture.fetch);
    const settings = { hidden_output_items: ['repo_card', 'language_breakdown'], github_card_style: 'generated' };
    const hidden = await client.fetchGitHubData(fixture.parsed, settings);
    assert.equal(fixture.requests.length, 1);
    assert.equal(hidden.ownerAvatar, null);
    assert.equal(hidden.languages, null);
    assert.equal(hidden.commitActivityCalendar, null);
    settings.hidden_output_items = [];
    fixture.requests.length = 0;
    const generated = await client.fetchGitHubData(fixture.parsed, settings);
    assert.equal(fixture.requests.length, 5);
    assert.ok(Buffer.isBuffer(generated.ownerAvatar));
    assert.equal(generated.commitActivityCalendar.total, 7);
    assert.equal(generated.languages.JavaScript, 8000);
    settings.github_card_style = 'github';
    fixture.requests.length = 0;
    await client.fetchGitHubData(fixture.parsed, settings);
    assert.equal(fixture.requests.length, 2);
    settings.hidden_output_items = ['language_breakdown'];
    fixture.requests.length = 0;
    await client.fetchGitHubData(fixture.parsed, settings);
    assert.equal(fixture.requests.length, 1);
});

test('provider performance: GitHub hidden requests do not change the pull-request checks predicate', async () => {
    const requests = [];
    const client = after.createGitHubClient(async url => {
        requests.push(url);
        return { ok: true, json: async () => url.endsWith('/status') ? { state: 'success' } : { head: { sha: 'abcdef1' } } };
    });
    const parsed = { type: 'pull', owner: 'owner', repo: 'repo', number: 1 };
    const visible = await client.fetchGitHubData(parsed, { hidden_output_items: ['repo_card'] });
    assert.equal(requests.length, 2);
    assert.equal(visible.status.state, 'success');
    requests.length = 0;
    const hidden = await client.fetchGitHubData(parsed, { hidden_output_items: ['checks'] });
    assert.equal(requests.length, 1);
    assert.equal(hidden.status, undefined);
});

function item(id) { return { contentId: id, url: `https://www.pixiv.net/artworks/${id}` }; }

test('provider performance: cursor preserves observation order, acknowledged filtering and old-ID tail', () => {
    const cursor = { seenContentIds: ['old-b', 'old-a', 'old-b', 'missing'], baselineMaxNumericContentId: '12345' };
    const observed = ['pending', 'old-a', 'accepted', 'old-b', 'accepted'].map(item);
    const acknowledged = ['accepted', 'absent'].map(item);
    const snapshot = structuredClone({ cursor, observed, acknowledged });
    const result = after.advanceCursor(cursor, observed, acknowledged);
    assert.deepEqual(result, { seenContentIds: ['old-a', 'accepted', 'old-b', 'missing'], baselineMaxNumericContentId: '12345' });
    assert.deepEqual(result, before.advanceCursor(cursor, observed, acknowledged));
    assert.deepEqual({ cursor, observed, acknowledged }, snapshot);
});

test('provider performance: cursor cap keeps exactly the first 5000 distinct accepted IDs', () => {
    const observed = Array.from({ length: 6001 }, (_, index) => item(String(index + 1)));
    observed.splice(1, 0, item('1'));
    const cursor = { seenContentIds: ['old-tail'], baselineMaxNumericContentId: '99999' };
    const result = after.advanceCursor(cursor, observed, observed, { seed: true });
    assert.equal(result.seenContentIds.length, 5000);
    assert.deepEqual(result.seenContentIds, Array.from({ length: 5000 }, (_, index) => String(index + 1)));
    assert.equal(result.baselineMaxNumericContentId, '99999');
    assert.deepEqual(result, before.advanceCursor(cursor, observed, observed, { seed: true }));
});

for (const scenario of cursorCases()) {
    test(`provider performance: cursor snapshot and baseline-model equivalence / ${scenario.name}`, () => {
        const actual = after.advanceCursor(...scenario.args);
        assert.deepEqual(actual, before.advanceCursor(...scenario.args));
        assert.deepEqual(actual, baselineCursorModel(...scenario.args));
    });
}

test('provider performance: cursor merge equivalence with fixed-seed duplicates and mixed IDs', () => {
    let seed = 0x13579bdf;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const values = ['', '0', 0, 1, '1', '2', 'old', 'pending', null, undefined];
    for (let i = 0; i < 100; i++) {
        const cursor = { seenContentIds: Array.from({ length: random() % 50 }, () => String(values[random() % values.length])), baselineMaxNumericContentId: '7000' };
        const observed = Array.from({ length: random() % 100 }, () => item(values[random() % values.length]));
        const accepted = observed.filter(() => random() % 3 === 0);
        for (const seedMode of [true, false]) {
            const args = [cursor, observed, accepted, { seed: seedMode }];
            assert.deepEqual(after.advanceCursor(...args), before.advanceCursor(...args));
        }
    }
});

test('provider performance: full initial baseline survives the 5000 cap and later historical observations', async () => {
    const { _internal } = require('../../src/providers/autoWatch/runner');
    const complete = [];
    const store = {
        atomicSourceCompletion: true,
        computedPollInterval: () => 30000, policyFor: () => ({}),
        reserveProviderRequest: async () => ({ allowed: true }), recordProviderRateLimit: async () => {},
        completeSource: async (_source, result) => complete.push(result),
        createItemsAndDeliveries: async () => assert.fail('Atomic completion must retain ownership of delivery creation'),
        failSource: async (_source, failure) => { throw failure.error; },
    };
    const source = { id: 'fixture-source', provider_id: 'pixiv', cursor_json: null, initialized_at_ms: null, lease_token: 'fixture-lease' };
    let items = Array.from({ length: 6001 }, (_, index) => item(String(index + 1)));
    const context = { now: 1000000, store, config: {}, sourceCounts: new Map([['pixiv', 1]]),
        fetchSource: async () => ({ items, state: { preserved: true }, etag: 'fixture-etag', lastModified: 'fixture-modified' }) };
    assert.equal((await _internal.processSource(source, context)).status, 'seeded');
    assert.equal(complete[0].cursor.seenContentIds.length, 5000);
    // The largest ID deliberately lies beyond the retained window.
    assert.equal(complete[0].cursor.baselineMaxNumericContentId, '6001');
    assert.equal(complete[0].items, undefined);
    source.initialized_at_ms = complete[0].initializedAtMs;
    source.cursor_json = JSON.stringify(complete[0].cursor);
    items = ['6002', '6001', '5999', '1'].map(item);
    assert.equal((await _internal.processSource(source, context)).newItemCount, 1);
    assert.deepEqual(complete[1].items.map(x => x.contentId), ['6002']);
    assert.equal(complete[1].cursor.seenContentIds.length, 5000);
    assert.equal(complete[1].cursor.seenContentIds[0], '6002');
    assert.equal(complete[1].cursor.baselineMaxNumericContentId, '6001');
    assert.equal(complete[1].etag, 'fixture-etag');
    assert.equal(complete[1].lastModified, 'fixture-modified');
    assert.deepEqual(complete[1].state, { preserved: true });
    assert.equal(complete[1].nextCheckAtMs, 1030000);
    assert.equal(source.lease_token, 'fixture-lease');

    source.cursor_json = JSON.stringify(complete[1].cursor);
    context.fetchSource = async () => ({ notModified: true, state: { preserved: true }, etag: 'fixture-etag', lastModified: 'fixture-modified' });
    assert.equal((await _internal.processSource(source, context)).status, 'not_modified');
    assert.deepEqual(complete[2].cursor, complete[1].cursor);
    assert.equal(complete[2].items, undefined);
});
