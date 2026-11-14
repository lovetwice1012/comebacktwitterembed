'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const { hashAttachment, findUnknownSend } = require('../../src/twitterGridRestoreRecovery');

test('recovery hashes only a bounded Discord CDN attachment and never follows redirects', async () => {
    const bytes = Buffer.from('fixture'), value = { url: 'https://cdn.discordapp.com/attachments/1/2/file.jpg' }, calls = [];
    const fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, body: Readable.from([bytes]) }; };
    assert.equal(await hashAttachment(value, { fetch }), createHash('sha256').update(bytes).digest('hex'));
    assert.equal(calls.length, 1); assert.equal(calls[0].options.redirect, 'manual');
    await assert.rejects(hashAttachment({ url: 'https://127.0.0.1/attachments/1/2/file.jpg' }, { fetch }), /GRID_RESTORE_UNAVAILABLE/);
    assert.equal(calls.length, 1);
    await assert.rejects(hashAttachment(value, { fetch: async () => ({ ok: false, status: 302 }) }), /GRID_RESTORE_UNAVAILABLE/);
    await assert.rejects(hashAttachment(value, { fetch: async () => ({ ok: true, body: Readable.from([]) }) }), /GRID_RESTORE_UNAVAILABLE/);
    await assert.rejects(hashAttachment(value, { fetch, budget: { bytes: 0, maxBytes: 3 } }), /GRID_RESTORE_UNAVAILABLE/);
    await assert.rejects(hashAttachment(value, { fetch, now: () => 1000, deadlineAtMs: 1000 }), /GRID_RESTORE_TIMEOUT/);
});

test('an unknown send is resolved only by one unambiguous Bot message in the scanned time window', async () => {
    const op = 'a'.repeat(32), channelId = '111111111111111111', botId = '222222222222222222', startedAtMs = Date.now();
    const fileName = `restore-${op}-10.jpg`, attachmentId = '333333333333333333';
    const proof = { name: fileName, sha256: 'f'.repeat(64) };
    const candidate = { id: '444444444444444444', channelId, author: { id: botId }, createdTimestamp: startedAtMs + 500,
        attachments: new Map([[attachmentId, { id: attachmentId, name: fileName, contentType: 'image/jpeg',
            url: `https://cdn.discordapp.com/attachments/${channelId}/${attachmentId}/${fileName}` }]]) };
    let messages = new Map([[candidate.id, candidate]]);
    const channel = { messages: { fetch: async () => messages } }, interaction = { channelId, client: { user: { id: botId } } };
    assert.equal((await findUnknownSend(channel, { startedAtMs }, { proofs: [proof] }, interaction)).id, candidate.id);
    messages = new Map([[candidate.id, candidate], ['555555555555555555', { ...candidate, id: '555555555555555555' }]]);
    assert.equal(await findUnknownSend(channel, { startedAtMs }, { proofs: [proof] }, interaction), null);
    messages = new Map([[candidate.id, { ...candidate, author: { id: '666666666666666666' } }]]);
    assert.equal(await findUnknownSend(channel, { startedAtMs }, { proofs: [proof] }, interaction), null);
    assert.equal(await findUnknownSend(channel, {}, { proofs: [proof] }, interaction), null);
    channel.messages.fetch = async () => { throw Error('denied'); };
    assert.equal(await findUnknownSend(channel, { startedAtMs }, { proofs: [proof] }, interaction), null);
});

test('a delayed Discord history read releases the deadline without accepting a late response', async () => {
    let release; const waiting = new Promise(resolve => { release = resolve; }), calls = [];
    const channel = { messages: { fetch: async options => { calls.push(options); return waiting; } } };
    const interaction = { channelId: '111111111111111111', client: { user: { id: '222222222222222222' } } };
    const result = await findUnknownSend(channel, { startedAtMs: Date.now() }, { proofs: [{ name: `restore-${'a'.repeat(32)}-0.jpg` }] }, interaction,
        { deadlineAtMs: Date.now() + 20 });
    assert.equal(result, null); assert.equal(calls.length, 1); assert.equal(calls[0].cache, false);
    release(new Map()); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
});
