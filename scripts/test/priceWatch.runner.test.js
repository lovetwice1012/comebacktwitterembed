'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tick } = require('../../src/providers/priceWatch/runner');

function source(overrides = {}) {
    return {
        id: 'source-1', provider_id: 'steam', product_key: 'app:730', product_url: 'https://store.steampowered.com/app/730',
        source_locale: 'ja', state_json: '{}', initialized_at_ms: null, poll_interval_ms: 1000,
        failure_count: 0, lease_token: 'lease-1', ...overrides,
    };
}

function storeWith(sources) {
    const calls = { complete: [], failed: [], deliveries: [], targetStates: [] };
    return {
        calls,
        claimDueSources: async () => sources,
        reserveProvider: async () => ({ allowed: true }),
        sourceTargets: async () => [{ id: 'target-1', watch_mode: 'change', destination_type: 'dm', user_id: 'user-1', condition_active: 0 }],
        completeSource: async (_source, snapshot, events, targetStates) => {
            calls.complete.push(snapshot); calls.deliveries.push(events); calls.targetStates.push(targetStates);
        },
        failSource: async (...args) => calls.failed.push(args),
        rescheduleSource: async () => {},
        claimDueDeliveries: async () => [],
        markDeliverySent: async () => {},
        markDeliverySuppressed: async () => {},
        failDelivery: async () => {},
    };
}

test('first price observation seeds a source and does not create an alert', async () => {
    const store = storeWith([source()]);
    const result = await tick({
        now: 1000,
        store,
        fetchPrice: async () => ({ productName: 'Fixture game', productUrl: 'https://store.steampowered.com/app/730', priceAmount: 2000, referencePriceAmount: 2000, discountPercent: 0, currency: 'JPY' }),
    });
    assert.equal(result.sources[0].status, 'seeded');
    assert.deepEqual(store.calls.deliveries, [[]]);
});

test('a later price change creates one change-notification delivery', async () => {
    const store = storeWith([source({ initialized_at_ms: 1, state_json: JSON.stringify({ productName: 'Fixture game', productUrl: 'https://store.steampowered.com/app/730', priceAmount: 2000, referencePriceAmount: 2000, discountPercent: 0, currency: 'JPY' }) })]);
    const result = await tick({
        now: 2000,
        store,
        fetchPrice: async () => ({ productName: 'Fixture game', productUrl: 'https://store.steampowered.com/app/730', priceAmount: 1500, referencePriceAmount: 2000, discountPercent: 25, currency: 'JPY' }),
    });
    assert.equal(result.sources[0].status, 'processed');
    assert.equal(store.calls.deliveries[0].length, 1);
    assert.match(store.calls.deliveries[0][0].messageText, /価格が変わりました/);
});

test('price-watch helper transitions can be evaluated without duplicate threshold alerts', () => {
    const { _internal } = require('../../src/providers/priceWatch/runner');
    const target = { max_price_amount: 1500, min_discount_percent: null };
    assert.equal(_internal.thresholdActive(target, { priceAmount: 1600, discountPercent: 0 }), false);
    assert.equal(_internal.thresholdActive(target, { priceAmount: 1500, discountPercent: 0 }), true);
    assert.equal(_internal.priceChanged({ priceAmount: 2000, currency: 'JPY' }, { priceAmount: 1500, currency: 'JPY' }), true);
});

test('repeated price transitions have distinct event identities, while replaying one observation is idempotent', () => {
    const { _internal } = require('../../src/providers/priceWatch/runner');
    const target = { id: '1', watch_mode: 'change' };
    const before = { priceAmount: 2000, currency: 'JPY' };
    const after = { priceAmount: 1000, currency: 'JPY', observationSequence: 2 };
    assert.notEqual(_internal.eventKey(target, before, after, false), _internal.eventKey(target, before, { ...after, observationSequence: 4 }, false));
    assert.equal(_internal.eventKey(target, before, after, false), _internal.eventKey(target, before, after, false));
    assert.equal(_internal.priceChanged({ priceAmount: null, currency: 'JPY' }, after), false);
});

test('currency changes cannot trigger price-change or numeric-threshold alerts and preserve the baseline', async () => {
    for (const watch_mode of ['change', 'threshold']) {
        const before = { priceAmount: 2000, currency: 'JPY', discountPercent: 0, observationSequence: 2 };
        const original = source({ initialized_at_ms: 1, state_json: JSON.stringify(before) });
        const store = storeWith([original]);
        let targetsRead = 0;
        store.sourceTargets = async () => {
            targetsRead++;
            return [{ id: 'target', watch_mode, max_price_amount: 1000, min_discount_percent: null, condition_active: 0, baseline_at_ms: 1 }];
        };
        const result = await tick({ now: 2000, store,
            fetchPrice: async () => ({ productName: 'Fixture', productUrl: original.product_url, priceAmount: 10, currency: 'USD', discountPercent: 0 }) });
        assert.equal(result.sources[0].status, 'failed', watch_mode);
        assert.equal(result.sources[0].errorCode, 'PRICE_WATCH_CURRENCY_CHANGED');
        assert.equal(targetsRead, 0);
        assert.equal(store.calls.complete.length, 0);
        assert.equal(store.calls.deliveries.length, 0);
        assert.equal(store.calls.failed.length, 1);
        assert.deepEqual(JSON.parse(original.state_json), before);
    }
});

test('price comparison rejects incomparable or missing prices while accepting a change to free', () => {
    const { priceChanged, messageFor } = require('../../src/providers/priceWatch/runner')._internal;
    const before = { priceAmount: 2000, currency: 'JPY' };
    assert.equal(priceChanged(before, { priceAmount: 10, currency: 'USD' }), false);
    assert.equal(priceChanged(before, { priceAmount: null, currency: 'JPY' }), false);
    assert.equal(priceChanged(before, { priceAmount: 0, currency: 'JPY' }), true);
    const text = messageFor({ watch_mode: 'change' }, { formatPrice: value => `${value.currency} ${value.priceAmount}` },
        before, { priceAmount: 10, currency: 'USD', productUrl: 'https://example.test', productName: 'Fixture' }, 'ja');
    assert.doesNotMatch(text, /1990/);
    assert.match(text, /通貨/);
});

test('invalid price snapshots cannot establish or overwrite a baseline; zero remains a valid price', async () => {
    for (const priceAmount of [null, undefined, '', ' ', -1, Infinity, NaN, false, []]) {
        const store = storeWith([source()]);
        const result = await tick({ now: 1000, store, fetchPrice: async () => ({ priceAmount, currency: 'JPY' }) });
        assert.equal(result.sources[0].errorCode, 'PRICE_WATCH_PRICE_UNAVAILABLE', String(priceAmount));
        assert.equal(store.calls.complete.length, 0);
    }
    const store = storeWith([source()]);
    const result = await tick({ now: 1000, store, fetchPrice: async () => ({ priceAmount: '0', currency: 'jpy' }) });
    assert.equal(result.sources[0].status, 'seeded');
    assert.equal(store.calls.complete[0].priceAmount, 0);
    assert.equal(store.calls.complete[0].currency, 'JPY');
});
