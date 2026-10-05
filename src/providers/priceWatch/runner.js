'use strict';

const crypto = require('crypto');
const storeDefault = require('./store');
const { fetchPrice: fetchPriceDefault, nextIntervalMs, provider } = require('./index');
const fetchDefault = require('../../providerFetch').withDeadline(require('node-fetch'));
const { recordError } = require('../../errorTracking');
const recoveryBootstrap = require('../../recoveryBootstrap');

const MINUTE = 60 * 1000;
const DEFAULT_TICK_MS = 30 * 1000;
const DEFAULT_START_DELAY_MS = 20 * 1000;

let timer = null;
let activeClient = null;

function stateOf(source) {
    return storeDefault.parseJson(source.state_json, {});
}

function number(value) {
    if (!['number', 'string'].includes(typeof value) || typeof value === 'string' && !value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function currencyOf(snapshot) {
    return String(snapshot?.currency || '').trim().toUpperCase();
}

function sameCurrency(before, after) {
    const currency = currencyOf(before);
    return /^[A-Z]{3}$/.test(currency) && currency === currencyOf(after);
}

function priceChanged(before, after) {
    return number(before?.priceAmount) !== null
        && number(after?.priceAmount) !== null && sameCurrency(before, after)
        && number(before.priceAmount) !== number(after.priceAmount);
}

function localeIsJapanese(locale) {
    return String(locale || '').toLowerCase().startsWith('ja');
}

function formatDiscount(value) {
    const amount = number(value);
    return amount && amount > 0 ? `${amount.toFixed(amount % 1 ? 2 : 0)}%` : '0%';
}

function formatDelta(adapter, before, after, locale) {
    if (!sameCurrency(before, after)) return localeIsJapanese(locale)
        ? '通貨が異なるため比較できません。' : 'Not comparable because the currency changed.';
    const difference = Number(after.priceAmount) - Number(before.priceAmount);
    const sign = difference > 0 ? '+' : difference < 0 ? '−' : '±';
    const sample = { ...after, priceAmount: Math.abs(difference) };
    return `${sign}${adapter.formatPrice(sample, locale)}`;
}

function messageFor(target, adapter, before, after, locale) {
    const ja = localeIsJapanese(locale);
    const title = after.productName || before?.productName || '商品';
    const url = after.productUrl;
    if (target.watch_mode === 'change') {
        return ja
            ? `🔔 価格が変わりました\n**${title}**\n${adapter.formatPrice(before, locale)} → **${adapter.formatPrice(after, locale)}**\n増減: ${formatDelta(adapter, before, after, locale)}\n${url}`
            : `🔔 Price changed\n**${title}**\n${adapter.formatPrice(before, locale)} → **${adapter.formatPrice(after, locale)}**\nChange: ${formatDelta(adapter, before, after, locale)}\n${url}`;
    }
    const conditions = [];
    if (target.max_price_amount !== null && target.max_price_amount !== undefined) conditions.push(ja ? `価格が ${target.max_price_amount} 以下` : `price is at most ${target.max_price_amount}`);
    if (target.min_discount_percent !== null && target.min_discount_percent !== undefined) conditions.push(ja ? `割引率が ${target.min_discount_percent}% 以上` : `discount is at least ${target.min_discount_percent}%`);
    return ja
        ? `🔔 価格条件に到達しました\n**${title}**\n現在価格: **${adapter.formatPrice(after, locale)}**\n割引率: ${formatDiscount(after.discountPercent)}\n条件: ${conditions.join(' / ')}\n${url}`
        : `🔔 Price condition met\n**${title}**\nCurrent price: **${adapter.formatPrice(after, locale)}**\nDiscount: ${formatDiscount(after.discountPercent)}\nCondition: ${conditions.join(' / ')}\n${url}`;
}

function thresholdActive(target, snapshot) {
    const price = number(snapshot.priceAmount);
    const discount = number(snapshot.discountPercent) || 0;
    const priceMatch = target.max_price_amount !== null && target.max_price_amount !== undefined
        && price !== null && price <= Number(target.max_price_amount);
    const discountMatch = target.min_discount_percent !== null && target.min_discount_percent !== undefined
        && discount >= Number(target.min_discount_percent);
    return priceMatch || discountMatch;
}

function eventKey(target, before, after, active) {
    return crypto.createHash('sha256').update(JSON.stringify({
        target: String(target.id), mode: target.watch_mode,
        oldPrice: before?.priceAmount ?? null, oldCurrency: before?.currency ?? null,
        price: after.priceAmount, currency: after.currency, discount: after.discountPercent,
        active,
        sequence: after.observationSequence,
    })).digest('hex');
}

function failureDelay(source, now, error) {
    const retry = Number(error?.retryAfterMs);
    if (Number.isFinite(retry) && retry >= 0) return now + retry;
    return now + Math.min(6 * 60 * MINUTE, MINUTE * (2 ** Math.min(Number(source.failure_count || 0), 8)));
}

async function processSource(source, context) {
    const { now, store, fetch, fetchPrice } = context;
    const adapter = provider(source.provider_id);
    const nextCheckAtMs = now + nextIntervalMs(source.provider_id);
    const permit = await store.reserveProvider(source.provider_id, adapter.globalSpacingMs, now);
    if (!permit.allowed) {
        await store.rescheduleSource(source, Math.max(now + 1000, permit.nextCheckAtMs));
        return { status: 'paced', sourceId: source.id };
    }
    try {
        const before = stateOf(source);
        const fetched = await fetchPrice(source, { fetch });
        const after = { ...fetched, priceAmount: number(fetched?.priceAmount), currency: currencyOf(fetched) };
        if (after.priceAmount === null || after.priceAmount < 0 || !/^[A-Z]{3}$/.test(after.currency)) {
            throw Object.assign(new Error('The source did not provide a valid price and currency.'), { code: 'PRICE_WATCH_PRICE_UNAVAILABLE' });
        }
        if (before.currency && !sameCurrency(before, after)) {
            // A source includes its market/locale. A changed currency cannot
            // be compared with a user's numeric threshold or prior price.
            throw Object.assign(new Error('The price currency changed; the previous baseline is retained.'), { code: 'PRICE_WATCH_CURRENCY_CHANGED' });
        }
        after.observationSequence = Number(before.observationSequence || 0) + 1;
        const targets = await store.sourceTargets(source.id);
        const initial = !source.initialized_at_ms;
        const events = [];
        const targetStates = [];
        for (const target of targets) {
            const active = target.watch_mode === 'threshold' ? thresholdActive(target, after) : false;
            targetStates.push({ targetId: target.id, conditionActive: active, ruleKey: target.rule_key, destinationKey: target.destination_key, configurationRevision: Number(target.configuration_revision || 1) });
            if (initial || target.baseline_at_ms === null) continue;
            const sendChange = target.watch_mode === 'change' && priceChanged(before, after);
            const sendThreshold = target.watch_mode === 'threshold' && active && !target.condition_active;
            if (!sendChange && !sendThreshold) continue;
            events.push({
                targetId: target.id,
                eventKey: eventKey(target, before, after, active),
                messageText: messageFor(target, adapter, before, after, source.source_locale),
                event: { providerId: source.provider_id, kind: 'price', sourceKey: source.product_key,
                    title: after.productName, url: after.productUrl, observedAtMs: now,
                    priceAmount: after.priceAmount, currency: after.currency, discountPercent: after.discountPercent,
                    previousPriceAmount: before.currency === after.currency ? before.priceAmount : null,
                    priceDelta: before.currency === after.currency && number(before.priceAmount) !== null ? after.priceAmount - before.priceAmount : null },
            });
        }
        await store.completeSource(source, after, events, targetStates, now, nextCheckAtMs);
        return { status: initial ? 'seeded' : 'processed', sourceId: source.id, eventCount: events.length };
    } catch (error) {
        const retryAt = failureDelay(source, now, error);
        if (Number(error?.status) === 429 || error?.code === 'PRICE_WATCH_RATE_LIMITED') {
            await store.cooldownProvider(source.provider_id, retryAt);
        }
        await store.failSource(source, error, now, retryAt);
        recordError(error, { errorType: 'price_watch_source_failed', source: 'priceWatch.processSource', providerId: source.provider_id, sourceId: source.id });
        return { status: 'failed', sourceId: source.id, errorCode: error?.code || 'PRICE_WATCH_UPSTREAM_ERROR' };
    }
}

function deliveryRetryAt(delivery, now, error) {
    const retry = Number(error?.retryAfterMs);
    if (Number.isFinite(retry) && retry >= 0) return now + retry;
    return now + Math.min(60 * MINUTE, 30 * 1000 * (2 ** Math.min(Number(delivery.attempt_count || 0), 8)));
}

async function deliverOne(delivery, context) {
    const { now, store } = context;
    const recoveryRecord = { id: delivery.id, target_id: delivery.target_id, destination_type: delivery.destination_type };
    if (!recoveryBootstrap.notificationAllowed('price_watch_delivery', recoveryRecord, Date.parse(delivery.created_at))) {
        await store.markDeliverySuppressed(delivery, now);
        return { status: 'suppressed', deliveryId: delivery.id };
    }
    try {
        if (typeof store.routeAutomation !== 'function') throw Object.assign(new Error('The guarded automation delivery runner is unavailable.'), { code: 'PRICE_WATCH_AUTOMATION_REQUIRED' });
        return { status: (await store.routeAutomation(delivery, now)).state, deliveryId: delivery.id };
    } catch (error) {
        const permanent = Number(error?.status) >= 400 && Number(error?.status) < 500 && Number(error?.status) !== 429;
        await store.failDelivery(delivery, error, now, deliveryRetryAt(delivery, now, error), permanent);
        recordError(error, { errorType: 'price_watch_delivery_failed', source: 'priceWatch.deliverOne', deliveryId: delivery.id });
        return { status: 'failed', deliveryId: delivery.id, errorCode: error?.code || 'PRICE_WATCH_DELIVERY_FAILED' };
    }
}

async function tick(options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const store = options.store || storeDefault;
    const fetch = options.fetch || fetchDefault;
    const client = options.client || activeClient;
    if (store === storeDefault) {
        const currentTime = () => options.now === undefined ? Date.now() : now;
        const sourceResults = [], deliveryResults = [];
        for (let index = 0; index < Math.min(128, Number(options.sourceLimit || 32)); index++) {
            const due = await store.claimDueSources(currentTime(), 1);
            if (!due.length) break;
            sourceResults.push(await processSource(due[0], { now: currentTime(), store, fetch, fetchPrice: options.fetchPrice || fetchPriceDefault }));
        }
        for (let index = 0; index < Math.min(256, Number(options.deliveryLimit || 64)); index++) {
            const due = await store.claimDueDeliveries(currentTime(), 1);
            if (!due.length) break;
            deliveryResults.push(await deliverOne(due[0], { now: currentTime(), store, fetch, client }));
        }
        return { sources: sourceResults, deliveries: deliveryResults };
    }
    const sources = await store.claimDueSources(now, Number(options.sourceLimit || 32));
    const sourceResults = [];
    for (const source of sources) sourceResults.push(await processSource(source, { now, store, fetch, fetchPrice: options.fetchPrice || fetchPriceDefault }));
    const deliveries = await store.claimDueDeliveries(now, Number(options.deliveryLimit || 64));
    const deliveryResults = [];
    for (const delivery of deliveries) deliveryResults.push(await deliverOne(delivery, { now, store, fetch, client }));
    return { sources: sourceResults, deliveries: deliveryResults };
}

function schedule(delayMs) {
    timer = setTimeout(async () => {
        try { await tick(); }
        catch (error) {
            recordError(error, { errorType: 'price_watch_tick_failed', source: 'priceWatch.tick' });
            console.error('[priceWatch] tick failed:', error?.code || error?.message || error);
        } finally {
            if (timer) schedule(Number(process.env.PRICE_WATCH_TICK_MS) || DEFAULT_TICK_MS);
        }
    }, delayMs);
}

function start(client = null) {
    if (client) activeClient = client;
    if (timer) return;
    schedule(Number(process.env.PRICE_WATCH_START_DELAY_MS) || DEFAULT_START_DELAY_MS);
}

function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
}

module.exports = {
    start,
    stop,
    tick,
    _internal: { deliverOne, eventKey, messageFor, priceChanged, thresholdActive },
};
