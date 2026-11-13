'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutboundGuard } = require('../../src/automation/outbound-guard');
const body = { content: 'https://example.test/post', embeds: [{ title: 'rendered', url: 'https://example.test/post' }] };
const event = (id, webhookId = 'webhook') => ({ ...structuredClone(body), id, webhookId, channelId: 'channel' });
test('a Gateway event arriving before the HTTP receipt is correlated without suppressing unrelated webhook posts', async () => {
    const guard = createOutboundGuard();
    const first = guard.begin('webhook', 'channel', body);
    const incoming = guard.shouldIgnore(event('own-message'));
    assert.equal(await guard.shouldIgnore(event('other-channel', 'another-webhook')), false);
    first.sent('own-message');
    assert.equal(await incoming, true);
    assert.equal(await guard.shouldIgnore(event('own-message')), true);
    const second = guard.begin('webhook', 'channel', body), foreign = guard.shouldIgnore(event('other-message'));
    second.sent('actual-new-message');
    assert.equal(await foreign, false, 'identical text on the same webhook is not enough after the receipt is known');
    assert.equal(await guard.shouldIgnore(event('normal-user', null)), false);
});
test('known failed submissions release foreign messages; unknown outcomes never trigger a second expansion', async () => {
    for (const uncertain of [false, true]) {
        const guard = createOutboundGuard(), ticket = guard.begin('webhook', 'channel', body);
        const incoming = guard.shouldIgnore(event('candidate'));
        ticket.failed(uncertain);
        assert.equal(await incoming, uncertain);
    }
});

test('late unknown Gateway events are suppressed for a bounded window and line endings are normalized', async () => {
    let clock = 0;
    const guard = createOutboundGuard({ now: () => clock });
    const ticket = guard.begin('webhook', 'channel', { ...body, content: body.content + '\r\ncaption' });
    ticket.failed(true);
    const late = { ...event('late'), content: body.content + '\ncaption' };
    assert.equal(await guard.shouldIgnore(late), true);
    clock = 300001;
    assert.equal(await guard.shouldIgnore(late), false);
});

test('normal notification receipts release early and late Gateway events to ordinary expansion', async () => {
    const guard = createOutboundGuard(), ticket = guard.begin('webhook', 'channel', body, { normalExpansion: true });
    const incoming = guard.shouldIgnore(event('normal-message'));
    ticket.sent('normal-message');
    assert.equal(await incoming, false);
    assert.equal(await guard.shouldIgnore(event('normal-message')), false);
    assert.equal(await guard.shouldIgnore(event('other-message')), false);
});

test('a visible normal notification can expand when its HTTP outcome is unknown', async () => {
    const guard = createOutboundGuard(), ticket = guard.begin('webhook', 'channel', body, { normalExpansion: true });
    const incoming = guard.shouldIgnore(event('visible-normal'));
    ticket.failed(true);
    assert.equal(await incoming, false);
    assert.equal(await guard.shouldIgnore(event('visible-normal')), false);
});

test('a correlated normal receipt overrides uncertain direct output with identical content', async () => {
    const guard = createOutboundGuard();
    guard.begin('webhook', 'channel', body).failed(true);
    const normal = guard.begin('webhook', 'channel', body, { normalExpansion: true });
    const incoming = guard.shouldIgnore(event('normal-after-unknown'));
    normal.sent('normal-after-unknown');
    assert.equal(await incoming, false);
    assert.equal(await guard.shouldIgnore(event('normal-after-unknown')), false);
    assert.equal(await guard.shouldIgnore(event('unknown-direct')), true);
});

test('only an exact acknowledged normal webhook receipt carries its trusted owner', async () => {
    let clock = 0;
    const owner = '222222222222222222', guard = createOutboundGuard({ now: () => clock });
    const first = guard.begin('webhook', 'channel', body, { normalExpansion: true, ownerUserId: owner });
    const early = guard.classify(event('confirmed'));
    first.sent('confirmed');
    assert.deepEqual(await early, { ignore: false, ownerUserId: owner });
    assert.deepEqual(await guard.classify(event('confirmed')), { ignore: false, ownerUserId: owner });
    assert.equal((await guard.classify(event('other-message'))).ownerUserId, undefined);
    assert.equal((await guard.classify(event('confirmed', 'other-webhook'))).ownerUserId, undefined);
    assert.equal((await guard.classify({ ...event('confirmed'), channelId: 'other-channel' })).ownerUserId, undefined);
    assert.equal((await guard.classify({ ...event('confirmed'), content: 'https://example.test/changed' })).ownerUserId, null,
        'a changed message cannot inherit the owner of the original notification');
    assert.equal((await createOutboundGuard().classify(event('confirmed'))).ownerUserId, undefined, 'restart cannot infer ownership');
    clock = 300001;
    assert.equal((await guard.classify(event('confirmed'))).ownerUserId, undefined, 'expired receipts cannot grant rights');
});

test('concurrent identical webhook bodies associate each owner only with its own message ID', async () => {
    const guard = createOutboundGuard(), a = '222222222222222222', b = '333333333333333333';
    const first = guard.begin('webhook', 'channel', body, { normalExpansion: true, ownerUserId: a });
    const second = guard.begin('webhook', 'channel', body, { normalExpansion: true, ownerUserId: b });
    const eventA = guard.classify(event('one')), eventB = guard.classify(event('two'));
    first.sent('one'); second.sent('two');
    assert.equal((await eventA).ownerUserId, a);
    assert.equal((await eventB).ownerUserId, b);
    assert.equal((await guard.classify(event('three'))).ownerUserId, undefined);
});

test('Discord-generated preview embeds do not prevent normal receipt owner correlation', async () => {
    const owner = '222222222222222222', guard = createOutboundGuard(), raw = { content: 'https://x.com/user/status/123' };
    const ticket = guard.begin('webhook', 'channel', raw, { normalExpansion: true, ownerUserId: owner });
    const preview = { ...event('with-preview'), content: raw.content, embeds: [{ title: 'Discord preview', url: raw.content }] };
    const early = guard.classify(preview);
    ticket.sent('with-preview');
    assert.deepEqual(await early, { ignore: false, ownerUserId: owner });
    assert.deepEqual(await guard.classify(preview), { ignore: false, ownerUserId: owner });
    assert.equal((await guard.classify({ ...preview, id: 'different' })).ownerUserId, undefined);
});

test('unknown, failed, direct-output and malformed owner cases never grant ownership', async () => {
    const owner = '222222222222222222';
    for (const variant of ['unknown', 'failed', 'direct', 'invalid']) {
        const guard = createOutboundGuard();
        const ticket = guard.begin('webhook', 'channel', body, {
            normalExpansion: variant !== 'direct', ownerUserId: variant === 'invalid' ? 'not-a-discord-id' : owner,
        });
        const waiting = guard.classify(event('candidate'));
        if (variant === 'unknown' || variant === 'failed') ticket.failed(variant === 'unknown');
        else ticket.sent('candidate');
        assert.equal((await waiting).ownerUserId ?? null, null, variant);
    }
});
