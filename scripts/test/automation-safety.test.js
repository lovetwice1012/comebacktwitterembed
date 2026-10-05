'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSafety, SafetyError, POLICY_VERSION } = require('../../src/automation/safety');
const { createTransport } = require('../../src/automation/transport');
const { createRunner } = require('../../src/automation/runtime');
const U = '222222222222222222', C = '333333333333333333', M = '444444444444444444';
const job = () => ({ id: 'fixture', owner_user_id: U, target_kind: 'auto', plan: { context: {}, event: {}, display: { format: 'text', media: 'inherit' }, text: 'harmless fixture' } });
const client = { options: { jsonTransformer: x => x } };
const approval = fingerprint => ({ fingerprint, policyVersion: POLICY_VERSION, detectorVersion: 'fixture-only-not-a-classifier', decision: 'allow', expiresAtMs: Date.now() + 10000 });
test('built-in mechanical checks work without external verifier or human approval for every format', async () => {
    let messages = 0;
    const rest = { post: async route => { if (route === '/users/@me/channels') return { id: C }; messages++; return { id: M, channel_id: C }; } };
    const transport = createTransport({}, {}, client, { rest });
    for (const variant of [{ display: { format: 'text', media: 'inherit' } }, { display: { format: 'url', media: 'inherit' } }, { display: { format: 'card', media: 'inherit' } }, { defaultPriceText: 'price observation' }, { members: [{ text: 'aggregate' }] }]) {
        const record = job(); Object.assign(record.plan, variant);
        const prepared = await transport.prepare(record, { kind: 'dm', dm_user_id: U });
        assert.equal(await transport.sendStep(prepared, record, 0), M);
    }
    assert.equal(messages, 5);
});
test('trusted verifier must assess exact payload including attachment bytes; failure and mutation never send', async () => {
    const record = job(), prepared = { payloads: [{ body: { content: 'harmless' }, files: [{ name: 'fixture.txt', data: Buffer.from('test') }] }] };
    for (const inspect of [async () => { throw new Error('secret internal exception'); }, async ({ fingerprint }) => ({ ...approval(fingerprint), fingerprint: 'wrong' }), async ({ fingerprint }) => ({ ...approval(fingerprint), decision: 'hold' })]) {
        await assert.rejects(createSafety({ verifier: { inspect } }).assertNotification(prepared, record), SafetyError);
    }
    const safety = createSafety({ verifier: { inspect: async ({ fingerprint, candidate }) => { assert.equal(candidate.payloads[0].files[0].bytes, 4); prepared.payloads[0].files[0].data = Buffer.from('changed'); return approval(fingerprint); } } });
    await assert.rejects(safety.assertNotification(prepared, record), { code: 'SAFETY_PAYLOAD_CHANGED' });
});
test('a valid fixture verdict permits only prepared messages and is rechecked on every step', async () => {
    let checked = 0, messages = 0;
    const safety = createSafety({ verifier: { inspect: async ({ fingerprint }) => { checked++; return approval(fingerprint); } } });
    const rest = { post: async route => { if (route === '/users/@me/channels') return { id: C }; messages++; return { id: M, channel_id: C }; } };
    const transport = createTransport({}, {}, client, { rest, safety });
    const record = job(), prepared = await transport.prepare(record, { kind: 'dm', dm_user_id: U });
    await assert.rejects(transport.sendStep({ ...prepared }, record, 0), { code: 'SAFETY_UNPREPARED_MESSAGE' });
    assert.equal(await transport.sendStep(prepared, record, 0), M);
    assert.equal(messages, 1); assert.equal(checked, 1);
});
test('checker errors terminate as failed, not held or unknown', async () => {
    const transitions = [], record = { ...job(), created_at_ms: 1 };
    record.plan.schedules = [];
    const queue = { claim: async () => record, check: async () => ({ state: 'ready', destination: {} }), beginSend: async () => ({ state: 'sending' }), transition: async (_job, state, code) => transitions.push({ state, code }) };
    const query = async sql => sql.startsWith('SELECT') ? [{ expires_at_ms: 0 }] : { affectedRows: 1 };
    const transport = { prepare: async () => ({ payloads: [{}] }), sendStep: async () => { throw new SafetyError('SAFETY_VERIFIER_UNAVAILABLE', 'error'); } };
    const runner = createRunner({ withDatabaseTransaction: work => work(query) }, queue, transport, { clock: () => 1000, assertAllowed: () => {}, notificationAllowed: () => true });
    assert.equal((await runner.tick()).state, 'failed');
    assert.deepEqual(transitions, [{ state: 'failed', code: 'SAFETY_VERIFIER_UNAVAILABLE' }]);
});

test('mechanical checks reject concrete unsafe indicators but do not hold unknown semantic content', async () => {
    const safety = createSafety();
    const record = job();
    for (const [content, code] of [['https://discord.com/api/webhooks/123456789012345678/fixture-token', 'SAFETY_CREDENTIAL_DISCLOSURE'], ['[link](javascript:alert)', 'SAFETY_UNSAFE_LINK'], ['http://127.0.0.1/private', 'SAFETY_PRIVATE_LINK']]) {
        await assert.rejects(safety.assertNotification({ payloads: [{ body: { content } }] }, record), { code, decision: 'deny' });
    }
    const prepared = { payloads: [{ body: { content: '正常な通知' }, files: [{ name: 'fixture.exe', data: Buffer.from('harmless') }] }] };
    await assert.rejects(safety.assertNotification(prepared, record), { code: 'SAFETY_EXECUTABLE_ATTACHMENT' });
    await createSafety().assertNotification({ payloads: [{ body: { content: '文脈や権利の確認は利用者が行う例' } }] }, record);
    await assert.rejects(createSafety({ verifier: null }).assertNotification({ payloads: [{ body: { content: 'normal' } }] }, record), { decision: 'error' });
});

test('default publication checker allows ordinary packages and applies the starter only to publication copy', async () => {
    const pack = { title: '通常のお知らせ', bundle: { schemaVersion: 1, kind: 'workflow', workflow: require('../../src/automation/schema').newWorkflow('お知らせ'), dictionaries: {}, license: 'CC0-1.0' } };
    const safety = createSafety({ clock: () => 1000 });
    assert.equal((await safety.assertPublication(pack)).detectorVersion, 'mechanical-v1');
    await safety.assertNotification({ payloads: [{ body: { content: 'xxx' } }] }, job());
    await assert.rejects(safety.assertPublication({ ...pack, title: 'xxx' }), { code: 'SAFETY_WORD_DENIED', decision: 'deny' });
    pack.bundle.dictionaries.words = { schemaVersion: 1, name: '除外語', source: 'fixture', license: 'CC0-1.0', entries: ['xxx'] };
    await safety.assertPublication(pack);
    pack.bundle.dictionaries.words.entries = ['https://discord.com/api/webhooks/123%2Ffixture-token'];
    await assert.rejects(safety.assertPublication(pack), { code: 'SAFETY_CREDENTIAL_DISCLOSURE', decision: 'deny' });
});

test('URL canonicalization checks encoded credentials, private addresses and dangerous link forms', async () => {
    const safety = createSafety();
    const denied = [
        ['https://discord.com/api/webhooks/123%2Ffixture-token', 'SAFETY_CREDENTIAL_DISCLOSURE'],
        ['https://discord.com./api/webhooks/123/fixture-token', 'SAFETY_CREDENTIAL_DISCLOSURE'],
        ['https://example.com/?access%5Ftoken=fixture-token', 'SAFETY_CREDENTIAL_DISCLOSURE'],
        ['https://example.com/?%61pi_key=fixture-token', 'SAFETY_CREDENTIAL_DISCLOSURE'],
        ['http:\\127.0.0.1/private', 'SAFETY_PRIVATE_LINK'],
        ['ＨＴＴＰ：／／１２７．０．０．１／', 'SAFETY_PRIVATE_LINK'],
        ['http://127.0.0.1../', 'SAFETY_INVALID_LINK'],
        ['http://0x7f000001/private', 'SAFETY_PRIVATE_LINK'],
        ['http://2130706433/private', 'SAFETY_PRIVATE_LINK'],
        ['http://[::ffff:127.0.0.1]/', 'SAFETY_PRIVATE_LINK'],
        ['http://intranet/private', 'SAFETY_PRIVATE_LINK'],
        ['[fixture]( JaVaScRiPt:alert)', 'SAFETY_UNSAFE_LINK'],
        ['[fixture](java\u200bscript:alert)', 'SAFETY_UNSAFE_LINK'],
        ['<file:///fixture.txt>', 'SAFETY_UNSAFE_LINK'],
    ];
    for (const [content, code] of denied) await assert.rejects(safety.assertNotification({ payloads: [{ body: { content } }] }, job()), { code, decision: 'deny' }, content);
    for (const content of ['https://example.com/path?q=hello%20world', 'https://example.com/path.', 'The authorization process uses a fixture.', '正常な絵文字 👨‍👩‍👧‍👦']) {
        await safety.assertNotification({ payloads: [{ body: { content } }] }, job());
    }
    await safety.assertNotification({ payloads: [{ body: { embeds: [{ image: { url: 'attachment://fixture.png' } }] }, files: [{ name: 'fixture.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }] }] }, job());
    await assert.rejects(safety.assertNotification({ payloads: [{ body: { embeds: [{ title: 'fixture', url: 'data:text/plain,fixture' }] } }] }, job()), { code: 'SAFETY_UNSAFE_LINK' });
});

test('attachment names and binary headers are inspected and sensitive aggregate members cannot hide in a safe parent', async () => {
    const safety = createSafety(), record = job();
    for (const file of [
        { name: 'fixture.ＥＸＥ', data: Buffer.from('fixture') },
        { name: 'fixture.p\u200bs1. ', data: Buffer.from('fixture') },
        { name: 'fixture.txt', data: Buffer.from('MZ fixture') },
        { name: 'fixture.txt', data: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) },
        { name: 'fixture.txt', data: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]) },
        { name: 'fixture.txt', data: Buffer.from('#!/bin/sh\n# fixture only') },
    ]) await assert.rejects(safety.assertNotification({ payloads: [{ body: { content: 'fixture' }, files: [file] }] }, record), { code: 'SAFETY_EXECUTABLE_ATTACHMENT' });
    for (const name of ['fixture.exe:sample.txt', 'fixture.exe\0.txt', '../fixture.txt']) {
        await assert.rejects(safety.assertNotification({ payloads: [{ body: { content: 'fixture' }, files: [{ name, data: Buffer.from('fixture') }] }] }, record), { code: 'SAFETY_INVALID_ATTACHMENT' });
    }
    record.plan.members = [{ event: { sensitive: false } }, { event: { sensitive: true } }];
    const prepared = { payloads: [{ body: { content: 'fixture' } }] };
    await assert.rejects(safety.assertNotification(prepared, record), { code: 'SAFETY_SENSITIVE_DESTINATION', decision: 'deny' });
    await safety.assertNotification({ ...prepared, channelNsfw: true }, record);
});

test('invalid structures, unavailable checkers, timeouts and malformed matcher results always reject with classified terminal errors', async () => {
    const safety = createSafety(), cyclic = {}; cyclic.self = cyclic;
    const values = [null, {}, { payloads: [] }, { payloads: Array(1) }, { payloads: [null] }, { payloads: [{ body: null }] },
        { payloads: [{ body: {} }] }, { payloads: [{ body: { content: '' } }] }, { payloads: [{ body: { embeds: [{}] } }] },
        { payloads: [{ body: { content: 1 } }] }, { payloads: [{ body: { embeds: [null] } }] }, { payloads: [{ body: cyclic }] },
        { payloads: [{ body: { embeds: [{ description: 5 }] } }] }, { payloads: [{ body: { embeds: [{ fields: [{ name: 'fixture', value: 5 }] }] } }] },
        { payloads: [{ body: { value: 1n } }] }, { payloads: [{ body: { value: new Map() } }] }, { payloads: [{ body: { content: 'ok' }, files: [null] }] }];
    for (const prepared of values) {
        let promise;
        assert.doesNotThrow(() => { promise = safety.assertNotification(prepared, job()); });
        await assert.rejects(promise, error => error instanceof SafetyError && error.beforeSubmission && error.decision === 'deny');
    }
    const prepared = { payloads: [{ body: { content: 'fixture' } }] };
    for (const value of [null, undefined, false, { length: 0 }]) {
        await assert.rejects(createSafety({ matcher: { matchNotification: async () => value } }).assertNotification(prepared, job()), { code: 'SAFETY_CHECK_FAILED', decision: 'error' });
    }
    await assert.rejects(createSafety({ matcher: { match: async () => [] } }).assertNotification(prepared, job()), { decision: 'error' });
    await assert.rejects(createSafety({ verifier: { inspect: () => new Promise(() => {}) }, timeoutMs: 5 }).assertNotification(prepared, job()), { code: 'SAFETY_CHECK_TIMEOUT', decision: 'error' });
    const throwing = { payloads: [{ get body() { throw new Error('private fixture'); } }] };
    await assert.rejects(safety.assertNotification(throwing, job()), { code: 'SAFETY_CHECK_FAILED', decision: 'error' });
    await assert.rejects(safety.assertPublication(null), { code: 'SAFETY_INVALID_PAYLOAD', decision: 'deny' });
});

test('publication candidate is detached and destination changes invalidate notification fingerprints', async () => {
    const pack = { title: 'fixture', bundle: { schemaVersion: 1, kind: 'dictionary', dictionaries: {}, license: 'CC0-1.0' } };
    await createSafety({ verifier: { inspect: async ({ candidate, fingerprint }) => {
        candidate.bundle.license = 'candidate-only'; return approval(fingerprint);
    } } }).assertPublication(pack);
    assert.equal(pack.bundle.license, 'CC0-1.0');
    const prepared = { channelId: C, webhook: { id: 'fixture-id', token: 'fixture-token' }, payloads: [{ body: { content: 'fixture' } }] };
    await assert.rejects(createSafety({ verifier: { inspect: async ({ fingerprint, candidate }) => {
        assert(!JSON.stringify(candidate).includes('fixture-token'));
        prepared.webhook.token = 'changed-fixture-token'; return approval(fingerprint);
    } } }).assertNotification(prepared, job()), { code: 'SAFETY_PAYLOAD_CHANGED' });
});
