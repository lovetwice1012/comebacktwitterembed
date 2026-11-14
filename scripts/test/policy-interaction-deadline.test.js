'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { InteractionType } = require('discord.js');
const provider = require('../../src/providers/_provider_settings');
const priceWatch = require('../../src/components/priceWatch');
const personal = require('../../src/components/personalLinks');
const user = '111111111111111111', bot = '222222222222222222', guildId = '333333333333333333', channelId = '444444444444444444', blocked = '888888888888888888';

function event(customId) {
    const calls = [], i = { type: InteractionType.MessageComponent, customId, guildId, channelId, locale: 'ja', user: { id: user },
        member: { roles: [] }, memberPermissions: { has: () => true }, client: { user: { id: bot }, rest: {} },
        message: { id: '555555555555555555', author: { id: bot } },
        channel: { messages: { fetch: async () => ({ author: { id: bot } }) } },
        reply: async value => { if (i.deferred || i.replied) throw Error('duplicate ACK'); i.replied = true; calls.push(['reply', value]); },
        deferReply: async () => { if (i.deferred || i.replied) throw Error('duplicate ACK'); i.deferred = true; calls.push(['defer']); },
        deferUpdate: async () => { if (i.deferred || i.replied) throw Error('duplicate ACK'); i.deferred = true; calls.push(['deferUpdate']); },
        editReply: async value => calls.push(['edit', value]),
        showModal: async value => { if (i.deferred || i.replied) throw Error('duplicate ACK'); i.replied = true; calls.push(['modal', value]); },
        deleteReply: async () => {} };
    return { i, calls };
}

test('price modal fails privately before ACK deadline and ignores a late role result', async t => {
    t.mock.method(provider, 'getSetting', async () => ({ role: [blocked] }));
    const f = event('priceWatchDestination:s:app:730:ja:123456789012345678'); f.i.values = ['threshold:dm'];
    f.i.createdTimestamp = Date.now() - 2390; let release, signal;
    const waiting = new Promise(resolve => { release = resolve; });
    f.i.client.rest.get = async (_path, options) => { signal = options.signal; return waiting; };
    assert.equal(await priceWatch.handle(f.i), false);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'reply'); assert.match(f.calls[0][1].content, /確認できません/);
    assert.equal(signal.aborted, true);
    release({ user: { id: user }, roles: [] }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 1); assert.equal(f.calls.some(call => call[0] === 'modal'), false);
});

test('price modal is shown exactly once for an allowed user and denied once for a restricted user', async t => {
    t.mock.method(provider, 'getSetting', async () => ({ role: [blocked] }));
    for (const [roles, expected] of [[[], 'modal'], [[blocked], 'reply']]) {
        const f = event('priceWatchDestination:s:app:730:ja:123456789012345678'); f.i.values = ['threshold:dm'];
        f.i.client.rest.get = async () => ({ user: { id: user }, roles });
        await priceWatch.handle(f.i);
        assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], expected);
    }
});

test('a submitted price modal defers first and uses editReply for denial', async t => {
    t.mock.method(provider, 'getSetting', async () => ({ role: [blocked] }));
    const f = event('priceWatchModal:threshold:dm:s:app:730:ja:123456789012345678'); f.i.type = InteractionType.ModalSubmit;
    f.i.client.rest.get = async () => ({ user: { id: user }, roles: [blocked] });
    await priceWatch.handleModal(f.i);
    assert.deepEqual(f.calls.map(call => call[0]), ['defer', 'edit']);
});

test('personal datetime modal times out on a late card read without later showing a modal', async () => {
    const id = 'a'.repeat(32), f = event(`personal:time:${id}:${user}:custom`); f.i.createdTimestamp = Date.now() - 2390;
    let release; const waiting = new Promise(resolve => { release = resolve; });
    await personal.handle(f.i, { getCard: async () => waiting });
    assert.deepEqual(f.calls.map(call => call[0]), ['reply']);
    release({ id, messageId: f.i.message.id, providerId: 'booth' }); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls.map(call => call[0]), ['reply']);
});

test('personal datetime modal does not proceed after a late permission response', async t => {
    t.mock.method(provider, 'getSetting', async () => ({ role: [blocked] }));
    const id = 'a'.repeat(32), f = event(`personal:time:${id}:${user}:custom`); f.i.createdTimestamp = Date.now() - 2390;
    let release, signal; const waiting = new Promise(resolve => { release = resolve; });
    f.i.client.rest.get = async (_path, options) => { signal = options.signal; return waiting; };
    await personal.handle(f.i, { getCard: async () => ({ id, messageId: f.i.message.id, providerId: 'booth' }) });
    assert.deepEqual(f.calls.map(call => call[0]), ['reply']); assert.equal(signal.aborted, true);
    release({ user: { id: user }, roles: [] }); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls.map(call => call[0]), ['reply']);
});

test('an already-expired pre-ACK budget starts no policy or card read and never opens a modal', async t => {
    let policies = 0, cards = 0;
    t.mock.method(provider, 'getSetting', async () => { policies++; return {}; });
    const p = event('priceWatchDestination:s:app:730:ja:123456789012345678'); p.i.values = ['threshold:dm']; p.i.createdTimestamp = Date.now() - 2500;
    assert.equal(await priceWatch.handle(p.i), false); assert.deepEqual(p.calls.map(call => call[0]), ['reply']); assert.equal(policies, 0);
    const id = 'a'.repeat(32), f = event(`personal:time:${id}:${user}:custom`); f.i.createdTimestamp = Date.now() - 2500;
    await personal.handle(f.i, { getCard: async () => { cards++; return null; } });
    assert.deepEqual(f.calls.map(call => call[0]), ['reply']); assert.equal(cards, 0);
});
