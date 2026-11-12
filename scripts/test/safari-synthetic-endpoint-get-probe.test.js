'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { summarize, requestWith, probeHostedSyntheticEndpoint } = require('../native-test/safari-synthetic-endpoint-get-probe.cjs');

function fakeConnection(callback) {
    let headers, origin, streamClosed = false, sessionClosed = false;
    const stream = new EventEmitter(); stream.end = () => callback(stream); stream.destroy = () => { streamClosed = true; };
    const session = new EventEmitter(); session.request = value => { headers = value; return stream; };
    session.destroy = () => { sessionClosed = true; };
    return { factory(value) { origin = value; return session; }, state: () => ({ headers, origin, streamClosed, sessionClosed }) };
}

test('the synthetic GET only reports a bounded status and closes the connection', async () => {
    const f = fakeConnection(stream => queueMicrotask(() => stream.emit('response', { ':status': 405, location: 'secret-url' })));
    const result = await requestWith(f.factory, 'https://web.push.apple.com/synthetic?fixture=1', 'vapid synthetic', 100);
    assert.deepEqual(result, { state: 'response', status: 405 });
    assert.equal(f.state().headers[':method'], 'GET'); assert.equal(f.state().headers[':path'], '/synthetic?fixture=1');
    assert.equal(f.state().headers.authorization, 'vapid synthetic');
    assert.equal(f.state().origin, 'https://web.push.apple.com');
    assert.equal(f.state().streamClosed, true); assert.equal(f.state().sessionClosed, true);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.deepEqual(summarize('200 secret'), { state: 'invalid_response' });
    assert.deepEqual(summarize(600), { state: 'invalid_response' });
});
test('transport errors, timeouts and untrusted destinations never reveal data', async () => {
    const error = fakeConnection(stream => queueMicrotask(() => stream.emit('error', new Error('secret-url'))));
    assert.deepEqual(await requestWith(error.factory, 'https://web.push.apple.com/fixture', undefined, 100), { state: 'transport_error' });
    const timeout = fakeConnection(() => {});
    assert.deepEqual(await requestWith(timeout.factory, 'https://web.push.apple.com/fixture', undefined, 100), { state: 'timeout' });
    assert.equal(timeout.state().sessionClosed, true);
    for (const value of ['https://example.com/', 'http://web.push.apple.com/', 'https://user@web.push.apple.com/'])
        assert.throws(() => requestWith(() => assert.fail('network'), value, undefined, 100), { code: 'FIXTURE_SAFARI_GET_INPUT_INVALID' });
    assert.throws(() => requestWith(() => assert.fail('network'), 'https://web.push.apple.com/fixture', 'Bearer secret', 100),
        { code: 'FIXTURE_SAFARI_GET_INPUT_INVALID' });
});
test('hosted endpoint probe refuses ordinary environments before any network request', async () => {
    if (process.platform === 'darwin' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted'
        && process.env.CBTE_SAFARI_PUSH_HOSTED === '1' && process.env.CBTE_SAFARI_SYNTHETIC_GET_PROBE === '1') return;
    await assert.rejects(probeHostedSyntheticEndpoint({}), { code: 'FIXTURE_SAFARI_GET_ENVIRONMENT_INVALID' });
});
