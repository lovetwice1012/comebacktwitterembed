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
