import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import https from 'node:https';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import {
  AckCode, AutoPushClient, AUTOPUSH_USER_AGENT, BACKOFF_WS_STATUS_CODE,
  MAX_WEBSOCKET_FRAME_BYTES,
  TWITTER_VAPID_PUBLIC_KEY, connectAndListen, isBackoffClose, isPong,
  parseResponse, registerNew, serializeMessage, unregister,
} from '../dist/autopush.js';
import { generateKeys } from '../dist/push.js';

const session = { uaid: 'dummy-uaid', channel_id: 'dummy-channel' };
const hello = (uaid = session.uaid, status = 200) => ({ messageType: 'hello', status, uaid });
const notification = (version = 'v1', channelID = session.channel_id) => ({ messageType: 'notification', channelID, version });
const registerResponse = (status = 200) => ({ messageType: 'register', status, channelID: 'server-channel', pushEndpoint: 'https://example.invalid/push' });
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const hasError = (code, match) => (error) => error.code === code && (!match || match.test(error.message));

async function fixture(t, handler = () => {}, extra = {}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong: false, ...extra });
  const messages = [], pings = [], pongs = [], requests = [], sockets = [], timers = [];
  const later = (milliseconds, callback) => { const timer = setTimeout(callback, milliseconds); timers.push(timer); };
  server.on('connection', (ws, request) => {
    sockets.push(ws); requests.push(request);
    ws.on('error', () => {});
    ws.on('message', (data, binary) => {
      const text = data.toString();
      const message = !binary ? JSON.parse(text) : null;
      messages.push(message);
      handler({ ws, message, text, binary, later, connection: sockets.length });
    });
    ws.on('ping', (data) => pings.push(Buffer.from(data)));
    ws.on('pong', (data) => pongs.push(Buffer.from(data)));
  });
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${server.address().port}/`;
  t.after(async () => {
    timers.forEach(clearTimeout);
    for (const ws of server.clients) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url, server, messages, pings, pongs, requests, sockets, later };
}
async function clientFor(t, server, options = {}) {
  const client = new AutoPushClient({ url: server.url, requestTimeoutMs: 80, ...options });
  t.after(() => client.close());
  await client.connect();
  return client;
}
async function until(check) {
  const deadline = Date.now() + 1000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'loopback event did not arrive');
    await sleep(2);
  }
}

test('AP-001 outgoing messages retain Rust tags, names, optional-field omission and ACK codes', () => {
  assert.equal(serializeMessage({ messageType: 'hello', uaid: '', use_webpush: true, broadcasts: {} }), '{"messageType":"hello","uaid":"","use_webpush":true,"broadcasts":{}}');
  assert.equal(serializeMessage({ messageType: 'hello', use_webpush: true, broadcasts: {} }), '{"messageType":"hello","use_webpush":true,"broadcasts":{}}');
  assert.deepEqual(JSON.parse(serializeMessage({ messageType: 'hello', uaid: 'u', channelIDs: ['c'], use_webpush: true, broadcasts: { a: 'b' } })), { messageType: 'hello', uaid: 'u', channelIDs: ['c'], use_webpush: true, broadcasts: { a: 'b' } });
  assert.equal(serializeMessage({ messageType: 'register', channelID: 'c' }), '{"messageType":"register","channelID":"c"}');
  assert.deepEqual([AckCode.Delivered, AckCode.DecryptionError, AckCode.NotDelivered], [100, 101, 102]);
  assert.equal(TWITTER_VAPID_PUBLIC_KEY.length, 65);
});
test('AP-002 serde response shapes, defaults, unknown fields and pong detection', () => {
  assert.deepEqual(parseResponse(JSON.stringify({ ...hello(), ignored: true })), { ...hello(), use_webpush: null, broadcasts: null });
  assert.deepEqual(parseResponse(JSON.stringify({ ...hello(), use_webpush: true, broadcasts: { key: 'value' } })), { ...hello(), use_webpush: true, broadcasts: { key: 'value' } });
  assert.deepEqual(parseResponse(JSON.stringify(registerResponse())), registerResponse());
  assert.deepEqual(parseResponse(JSON.stringify(notification())), { ...notification(), data: null, headers: null });
  assert.deepEqual(parseResponse(JSON.stringify({ ...notification(), data: 'abcd', headers: { encoding: 'aes128gcm' } })), { ...notification(), data: 'abcd', headers: { encoding: 'aes128gcm' } });
  for (const input of ['{}', '{"broadcasts":{}}', '{"anything":null}', ' { } ']) assert.equal(isPong(input), true, input);
  for (const input of ['null', '[]', '1', '"{}"', '{', '{"messageType":null}', '{"messageType":"hello"}']) assert.equal(isPong(input), false, input);
  for (const code of [undefined, null, 1000, 1005, 1006]) assert.equal(isBackoffClose(code), false);
  assert.equal(isBackoffClose(BACKOFF_WS_STATUS_CODE), true);
});
test('AP-003 malformed messages fail safely with Json errors', () => {
  const invalid = ['{', 'null', '[]', '{}', '{"messageType":"unknown"}',
    JSON.stringify({ ...hello(), status: -1 }), JSON.stringify({ ...hello(), status: 65536 }), JSON.stringify({ ...hello(), status: 1.5 }),
    JSON.stringify({ ...hello(), status: '200' }), JSON.stringify({ ...hello(), uaid: 1 }),
    JSON.stringify({ ...hello(), use_webpush: 1 }), JSON.stringify({ ...hello(), broadcasts: { key: 1 } }),
    JSON.stringify({ messageType: 'register', status: 200 }), JSON.stringify({ ...registerResponse(), channelID: null }),
    JSON.stringify({ ...notification(), version: 12 }), JSON.stringify({ ...notification(), data: 1 }),
    JSON.stringify({ ...notification(), headers: [] }), JSON.stringify({ ...notification(), headers: { bad: null } }),
  ];
  for (const input of invalid) assert.throws(() => parseResponse(input), hasError('Json'));
  const secret = 'SENSITIVE_DUMMY_PAYLOAD';
  assert.throws(() => parseResponse(secret), (error) => error.code === 'Json' && !error.message.includes(secret));
});
test('AP-004 new registration sends exact HELLO, VAPID, UUID and closes', async (t) => {
  const server = await fixture(t, ({ ws, message }) => {
    if (message.messageType === 'hello') ws.send(JSON.stringify(hello()));
    if (message.messageType === 'register') ws.send(JSON.stringify(registerResponse()));
  });
  const result = await registerNew(generateKeys(), { url: server.url, requestTimeoutMs: 100 });
  assert.equal(result.uaid, session.uaid);
  assert.equal(result.endpoint, registerResponse().pushEndpoint);
  assert.match(result.channel_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(server.messages[0], { messageType: 'hello', uaid: '', use_webpush: true, broadcasts: {} });
  assert.deepEqual(server.messages[1], { messageType: 'register', channelID: result.channel_id, key: TWITTER_VAPID_PUBLIC_KEY.toString('base64url') });
  assert.equal(server.requests[0].headers['user-agent'], AUTOPUSH_USER_AGENT);
  assert.equal(server.requests[0].headers.origin, 'https://x.com');
  assert.equal(server.requests[0].headers['sec-websocket-extensions'], undefined);
  await until(() => server.sockets[0].readyState === 3);
});
test('AP-005 reconnect preserves matching UAID/channel and starts a fresh duplicate cache', async (t) => {
  const server = await fixture(t, ({ ws, message }) => { if (message.messageType === 'hello') ws.send(JSON.stringify(hello())); });
  const result = await connectAndListen(session, generateKeys(), { url: server.url, requestTimeoutMs: 100 });
  assert.equal(result.kind, 'Connected');
  t.after(() => result.client.close());
  assert.equal(result.client.uaid(), session.uaid);
  assert.equal(result.client.channelId(), session.channel_id);
  assert.equal(result.client.channel_id(), session.channel_id);
  assert.deepEqual(server.messages, [{ messageType: 'hello', uaid: session.uaid, use_webpush: true, broadcasts: {} }]);
});
test('AP-006 UAID mismatch performs full legacy fresh-key registration only when authorized', async (t) => {
  const server = await fixture(t, ({ ws, message, connection }) => {
    if (message.messageType === 'hello') ws.send(JSON.stringify(hello(connection === 1 ? 'reassigned' : 'fresh-uaid')));
    if (message.messageType === 'register') ws.send(JSON.stringify(registerResponse()));
  });
  const oldKeys = generateKeys();
  const result = await connectAndListen(session, oldKeys, { url: server.url, requestTimeoutMs: 100, allowReregistration: true });
  assert.equal(result.kind, 'NeedsReregistration');
  assert.equal(result.registration.uaid, 'fresh-uaid');
  assert.notDeepEqual(result.keys, oldKeys);
  assert.equal(result.keys.public_key.length, 65);
  assert.equal(result.keys.private_key.length, 32);
  assert.equal(result.keys.auth_secret.length, 16);
  assert.deepEqual(server.messages.map((message) => message.messageType), ['hello', 'hello', 'register']);
  assert.equal(server.messages[1].uaid, '');
  assert.ok(server.messages.every((message) => !Object.hasOwn(message, 'channelIDs')));
});
test('AP-007 unauthorized UAID recovery stops without creating a registration', async (t) => {
  const server = await fixture(t, ({ ws }) => ws.send(JSON.stringify(hello('different-uaid'))));
  await assert.rejects(connectAndListen(session, generateKeys(), { url: server.url, requestTimeoutMs: 100 }), hasError('AutoPush', /UAID invalid/));
  assert.equal(server.sockets.length, 1);
  assert.deepEqual(server.messages.map((message) => message.messageType), ['hello']);
});
test('AP-008 unregister sends code 200, permits response UAID change like Rust, needs no unregister reply', async (t) => {
  const server = await fixture(t, ({ ws, message }) => { if (message.messageType === 'hello') ws.send(JSON.stringify(hello('different-uaid'))); });
  await unregister(session, { url: server.url, requestTimeoutMs: 100 });
  assert.deepEqual(server.messages, [
    { messageType: 'hello', uaid: session.uaid, use_webpush: true, broadcasts: {} },
    { messageType: 'unregister', channelID: session.channel_id, code: 200 },
  ]);
});
test('AP-009 all ACK outcomes use channelID/version/code and aliases retain behavior', async (t) => {
  const server = await fixture(t);
  const client = await clientFor(t, server);
  await client.ack('c', '1');
  await client.ackNotification('c', '2', AckCode.DecryptionError);
  await client.ack_notification('c', '3', AckCode.NotDelivered);
  await until(() => server.messages.length === 3);
  assert.deepEqual(server.messages, [100, 101, 102].map((code, index) => ({ messageType: 'ack', updates: [{ channelID: 'c', version: String(index + 1), code }] })));
});
test('AP-010 HELLO status, wrong response, binary, close and timeout branches', async (t) => {
  const cases = [
    ['failure', (ws) => ws.send(JSON.stringify(hello('dummy', 401))), 'AutoPush', /hello failed/],
    ['wrong tag', (ws) => ws.send(JSON.stringify(registerResponse())), 'AutoPush', /expected hello/],
    ['malformed', (ws) => ws.send('sensitive-dummy-json'), 'Json'],
    ['binary', (ws) => ws.send(Buffer.from('{}')), 'AutoPush', /unexpected message/],
    ['ping', (ws) => ws.ping('abc'), 'AutoPush', /unexpected message/],
    ['normal close', (ws) => ws.close(1000), 'AutoPush', /unexpected message/],
    ['abnormal close', (ws) => ws.terminate(), 'WebSocket'],
    ['timeout', () => {}, 'AutoPush', /hello response timed out/],
  ];
  for (const [name, action, code, match] of cases) await t.test(name, async (subtest) => {
    const server = await fixture(subtest, ({ ws }) => action(ws));
    const client = await clientFor(subtest, server, { requestTimeoutMs: 30 });
    await assert.rejects(client.hello(), hasError(code, match));
  });
});
test('AP-011 REGISTER status, wrong response, parse, binary, close and timeout branches', async (t) => {
  const cases = [
    ['failure', (ws) => ws.send(JSON.stringify(registerResponse(409))), 'AutoPush', /register failed/],
    ['wrong tag', (ws) => ws.send(JSON.stringify(hello())), 'AutoPush', /expected register/],
    ['malformed', (ws) => ws.send('bad-json'), 'Json'],
    ['binary', (ws) => ws.send(Buffer.from('{}')), 'AutoPush', /unexpected message/],
    ['normal close', (ws) => ws.close(1000), 'AutoPush', /unexpected message/],
    ['abnormal close', (ws) => ws.terminate(), 'WebSocket'],
    ['timeout', () => {}, 'AutoPush', /register response timed out/],
  ];
  for (const [name, action, code, match] of cases) await t.test(name, async (subtest) => {
    const server = await fixture(subtest, ({ ws }) => action(ws));
    const client = await clientFor(subtest, server, { requestTimeoutMs: 30 });
    await assert.rejects(client.register('fixed-channel'), hasError(code, match));
  });
});
test('AP-012 contextual HELLO errors preserve reconnect and unregister diagnostics', async (t) => {
  for (const context of ['reconnect', 'unregister']) await t.test(context, async (subtest) => {
    const server = await fixture(subtest, ({ ws }) => ws.send(JSON.stringify(hello('dummy', 503))));
    const client = await clientFor(subtest, server);
    await assert.rejects(client.hello('old', context), hasError('AutoPush', new RegExp(`hello failed \\(${context}\\)`)));
  });
});
test('AP-013 notification loop skips pongs, binary, known non-notifications and replies to RFC ping', async (t) => {
  const server = await fixture(t);
  const client = await clientFor(t, server);
  const pending = client.nextNotification();
  const ws = server.sockets[0];
  ws.send('{}'); ws.send('{"other":"pong"}'); ws.send(JSON.stringify(hello()));
  ws.send(JSON.stringify(registerResponse())); ws.send(Buffer.from('ignored binary'));
  ws.pong('unsolicited'); ws.ping('ping-payload');
  ws.send(JSON.stringify({ ...notification(), data: 'ciphertext', headers: { encoding: 'aesgcm' } }));
  assert.deepEqual(await pending, { channel_id: session.channel_id, version: 'v1', data: 'ciphertext', headers: { encoding: 'aesgcm' } });
  await until(() => server.pongs.length === 1);
  assert.equal(server.pongs[0].toString(), 'ping-payload');
});
test('AP-014 duplicate version is globally suppressed and ACKed, including across different channels', async (t) => {
  const server = await fixture(t);
  const client = await clientFor(t, server);
  server.sockets[0].send(JSON.stringify(notification('same')));
  assert.equal((await client.nextNotification()).version, 'same');
  const pending = client.nextNotification();
  server.sockets[0].send(JSON.stringify(notification('same', 'other-channel')));
  server.sockets[0].send(JSON.stringify(notification('next')));
  assert.equal((await pending).version, 'next');
  await until(() => server.messages.length === 1);
  assert.deepEqual(server.messages[0], { messageType: 'ack', updates: [{ channelID: 'other-channel', version: 'same', code: 100 }] });
});
test('AP-015 recent-message cache evicts oldest after exactly 100 IDs', async (t) => {
  const server = await fixture(t);
  const client = await clientFor(t, server);
  for (let index = 0; index <= 100; index++) {
    server.sockets[0].send(JSON.stringify(notification(String(index))));
    assert.equal((await client.nextNotification()).version, String(index));
  }
  server.sockets[0].send(JSON.stringify(notification('0')));
  assert.equal((await client.nextNotification()).version, '0');
  assert.equal(server.messages.length, 0);
});
test('AP-016 unknown tags and invalid JSON in notification loop are errors rather than ignored', async (t) => {
  for (const message of ['{"messageType":"unregister","status":200}', 'dummy-malformed']) await t.test(message, async (subtest) => {
    const server = await fixture(subtest);
    const client = await clientFor(subtest, server);
    const pending = assert.rejects(client.nextNotification(), hasError('Json'));
    server.sockets[0].send(message);
    await pending;
  });
});
test('AP-017 normal close, empty close, stream end, backoff and transport failure', async (t) => {
  for (const code of [1000, undefined, BACKOFF_WS_STATUS_CODE, 1006]) await t.test(String(code), async (subtest) => {
    const server = await fixture(subtest);
    const client = await clientFor(subtest, server);
    if (code === 4774 || code === 1006) {
      const pending = assert.rejects(client.nextNotification(), hasError(code === 4774 ? 'AutoPush' : 'WebSocket', code === 4774 ? /BACKOFF:/ : undefined));
      if (code === 1006) server.sockets[0].terminate(); else server.sockets[0].close(code);
      await pending;
    } else {
      const pending = client.nextNotification();
      server.sockets[0].close(code);
      assert.equal(await pending, null);
      assert.equal(await client.nextNotification(), null);
    }
  });
});
test('AP-018 WebSocket idle ping is independent from application ping', async (t) => {
  const server = await fixture(t);
  const client = await clientFor(t, server, { wsPingIntervalMs: 15, appPingIntervalMs: 200 });
  const pending = client.nextNotification();
  await until(() => server.pings.length >= 2);
  assert.ok(server.pings.every((ping) => ping.length === 0));
  assert.equal(server.messages.length, 0);
  server.sockets[0].send(JSON.stringify(notification()));
  assert.equal((await pending).version, 'v1');
});
test('AP-019 any received message resets both ping timers, including an RFC pong', async (t) => {
  const server = await fixture(t);
  const client = await clientFor(t, server, { appPingIntervalMs: 45, wsPingIntervalMs: 100 });
  const pending = client.nextNotification();
  await sleep(25);
  server.sockets[0].pong();
  await sleep(25);
  assert.equal(server.messages.length, 0);
  server.sockets[0].send(JSON.stringify(notification()));
  assert.equal((await pending).version, 'v1');
});
test('AP-020 application pong handles both empty and untagged objects then resumes listening', async (t) => {
  for (const pong of ['{}', '{"broadcasts":{"id":"version"}}']) await t.test(pong, async (subtest) => {
    const server = await fixture(subtest, ({ ws, message, later }) => {
      if (!message.messageType) { ws.send(pong); later(5, () => ws.send(JSON.stringify(notification()))); }
    });
    const client = await clientFor(subtest, server, { appPingIntervalMs: 15, wsPingIntervalMs: 100 });
    assert.equal((await client.nextNotification()).version, 'v1');
    assert.deepEqual(server.messages, [{}]);
  });
});
test('AP-021 notifications while awaiting app pong preserve the Rust cache bypass', async (t) => {
  const server = await fixture(t, ({ ws, message }) => { if (!message.messageType) ws.send(JSON.stringify(notification('during-pong'))); });
  const client = await clientFor(t, server, { appPingIntervalMs: 10, wsPingIntervalMs: 100 });
  assert.equal((await client.nextNotification()).version, 'during-pong');
  // Rust's pong-wait path returns without populating the cache; retain this observable behavior.
  server.sockets[0].send(JSON.stringify(notification('during-pong')));
  assert.equal((await client.nextNotification()).version, 'during-pong');
  assert.equal(server.messages.filter((message) => message.messageType === 'ack').length, 0);
});
test('AP-022 pong wait handles RFC ping/pong, binary and known non-notifications before app pong', async (t) => {
  const server = await fixture(t, ({ ws, message, later }) => {
    if (!message.messageType) {
      ws.ping('in-pong-wait'); ws.pong(); ws.send(Buffer.from('ignored'));
      ws.send(JSON.stringify(hello())); ws.send(JSON.stringify(registerResponse())); ws.send('{}');
      later(5, () => ws.send(JSON.stringify(notification())));
    }
  });
  const client = await clientFor(t, server, { appPingIntervalMs: 15, wsPingIntervalMs: 100 });
  assert.equal((await client.nextNotification()).version, 'v1');
  await until(() => server.pongs.length === 1);
  assert.equal(server.pongs[0].toString(), 'in-pong-wait');
});
test('AP-023 pong wait branches: timeout, unknown response, malformed JSON, closes and stream error', async (t) => {
  const cases = [
    ['timeout', () => {}, 'AutoPush', /pong timed out/],
    ['unknown', (ws) => ws.send('{"messageType":"unknown"}'), 'Json'],
    ['malformed', (ws) => ws.send('invalid-json'), 'Json'],
    ['close', (ws) => ws.close(1000), null],
    ['backoff', (ws) => ws.close(4774), 'AutoPush', /BACKOFF:/],
    ['transport', (ws) => ws.terminate(), 'WebSocket'],
  ];
  for (const [name, action, code, match] of cases) await t.test(name, async (subtest) => {
    const server = await fixture(subtest, ({ ws, message }) => { if (!message.messageType) action(ws); });
    const client = await clientFor(subtest, server, { appPingIntervalMs: 10, wsPingIntervalMs: 100, requestTimeoutMs: 25 });
    if (code) await assert.rejects(client.nextNotification(), hasError(code, match));
    else assert.equal(await client.nextNotification(), null);
  });
});
test('AP-024 pong wait deadline is absolute, even with repeated irrelevant frames', async (t) => {
  const server = await fixture(t, ({ ws, message, later }) => {
    if (!message.messageType) for (let index = 1; index < 12; index++) later(index * 4, () => { if (ws.readyState === 1) ws.pong(); });
  });
  const client = await clientFor(t, server, { appPingIntervalMs: 10, wsPingIntervalMs: 100, requestTimeoutMs: 25 });
  await assert.rejects(client.nextNotification(), hasError('AutoPush', /pong timed out/));
});
test('AP-025 receive cancellation and timeout do not consume a later message', async (t) => {
  const server = await fixture(t);
  const client = await clientFor(t, server);
  await assert.rejects(client.receive(5), hasError('AutoPush', /receive timed out/));
  server.sockets[0].send('next-frame');
  assert.deepEqual(await client.receive(80), { type: 'text', data: 'next-frame' });
  const waiting = client.receive(100);
  await assert.rejects(client.receive(10), hasError('AutoPush', /concurrent receives/));
  server.sockets[0].send('frame-after-concurrent-check');
  assert.equal((await waiting).data, 'frame-after-concurrent-check');
});
test('AP-026 AbortSignal interrupts notification receive and request wait cleanly', async (t) => {
  for (const method of ['nextNotification', 'hello']) await t.test(method, async (subtest) => {
    const controller = new AbortController();
    const server = await fixture(subtest);
    const client = await clientFor(subtest, server, { signal: controller.signal });
    const pending = assert.rejects(client[method](), hasError('Io', /aborted/));
    controller.abort();
    await pending;
    await assert.rejects(client.ack('c', 'v'), hasError('Io'));
  });
});
test('AP-027 AbortSignal rejects before connection and during a stalled HTTP upgrade', async (t) => {
  const preaborted = new AbortController(); preaborted.abort();
  await assert.rejects(new AutoPushClient().connect('ws://127.0.0.1:1', preaborted.signal), hasError('Io'));
  const tcpServer = net.createServer((socket) => { socket.on('data', () => {}); socket.on('error', () => {}); });
  tcpServer.listen(0, '127.0.0.1'); await once(tcpServer, 'listening');
  t.after(() => new Promise((resolve) => tcpServer.close(resolve)));
  const controller = new AbortController();
  const client = new AutoPushClient();
  const pending = assert.rejects(client.connect(`ws://127.0.0.1:${tcpServer.address().port}/`, controller.signal), hasError('Io'));
  await sleep(10); controller.abort(); await pending;
});
test('AP-028 invalid URLs, timer configuration and operations without a connection', async () => {
  for (const url of ['bad-url', 'https://example.invalid', 'ws://127.0.0.1:4/#fragment']) await assert.rejects(new AutoPushClient().connect(url), hasError('AutoPush'));
  for (const timer of [0, -1, Infinity, NaN]) assert.throws(() => new AutoPushClient({ requestTimeoutMs: timer }), hasError('Config'));
  const client = new AutoPushClient();
  await assert.rejects(client.receive(), hasError('AutoPush', /not connected/));
  await assert.rejects(client.ack('c', 'v'), hasError('WebSocket'));
  await client.close();
});
test('AP-029 TCP refusal, duplicate connect and sends after close use preserved error categories', async (t) => {
  const closedPortServer = net.createServer(); closedPortServer.listen(0, '127.0.0.1'); await once(closedPortServer, 'listening');
  const port = closedPortServer.address().port;
  await new Promise((resolve) => closedPortServer.close(resolve));
  const failed = new AutoPushClient();
  await assert.rejects(failed.connect(`ws://127.0.0.1:${port}/`), hasError('AutoPush', /connect failed/));
  await failed.close();
  const server = await fixture(t);
  const client = await clientFor(t, server);
  await assert.rejects(client.connect(), hasError('AutoPush', /already connected/));
  await client.close();
  await assert.rejects(client.unregister('c'), hasError('WebSocket'));
  await client.close();
});

// Disposable localhost TLS test fixture; this public dummy key is never used for a service.
const tlsKey = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtDKaoN3y/wifDDbN
86YrjudLDFISwd23yZ83TMvBVaOhRANCAAQcU+fghupm9IgzAIDi4p0XzYRbRBpB
kIQis/lnjoKZ9hhqRCNX+DUsT20NiXhDQa4kFMW/3ATnbImvqf4JaQrK
-----END PRIVATE KEY-----`;
const tlsCert = `-----BEGIN CERTIFICATE-----
MIIBmDCCAT+gAwIBAgIUc4vefhSrvaYKwWS/bLi3tGMGsCUwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAxMzE0MjYzNVoXDTM2MTAxMDE0
MjYzNVowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEHFPn4IbqZvSIMwCA4uKdF82EW0QaQZCEIrP5Z46CmfYYakQjV/g1LE9t
DYl4Q0GuJBTFv9wE52yJr6n+CWkKyqNvMG0wHQYDVR0OBBYEFKFbJa8lhEFb06FH
y4CxILVJpnKQMB8GA1UdIwQYMBaAFKFbJa8lhEFb06FHy4CxILVJpnKQMA8GA1Ud
EwEB/wQFMAMBAf8wGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAoGCCqGSM49
BAMCA0cAMEQCIHdMtQzXFKV1V3nP5AvLlz9dYQpua8FeDjxlC+O8risoAiA23war
gF4VP7kRY7GfSb+bLTKU1gpo2TJA9OiKZljk3g==
-----END CERTIFICATE-----`;

test('AP-030 WSS rejects an untrusted certificate and accepts an explicitly trusted localhost CA', async (t) => {
  const tlsServer = https.createServer({ key: tlsKey, cert: tlsCert });
  const wsServer = new WebSocketServer({ server: tlsServer });
  wsServer.on('connection', (ws) => ws.on('message', () => ws.send(JSON.stringify(hello()))));
  tlsServer.listen(0, '127.0.0.1');
  await once(tlsServer, 'listening');
  const url = `wss://127.0.0.1:${tlsServer.address().port}/`;
  t.after(async () => {
    for (const ws of wsServer.clients) ws.terminate();
    await new Promise((resolve) => wsServer.close(resolve));
    await new Promise((resolve) => tlsServer.close(resolve));
  });
  const untrusted = new AutoPushClient({ url });
  await assert.rejects(untrusted.connect(), hasError('AutoPush', /connect failed/));
  await untrusted.close();
  const trusted = new AutoPushClient({ url, tls: { ca: tlsCert }, requestTimeoutMs: 100 });
  t.after(() => trusted.close());
  await trusted.connect();
  assert.equal((await trusted.hello()).uaid, session.uaid);
  await trusted.close();
});

test('AP-031 malformed HTTP upgrade is an AutoPush connection failure', async (t) => {
  const server = net.createServer((socket) => {
    socket.once('data', () => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'));
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new AutoPushClient();
  await assert.rejects(client.connect(`ws://127.0.0.1:${server.address().port}/`), hasError('AutoPush'));
  await client.close();
});

test('AP-032 Rust 16 MiB frame cap rejects one oversized frame while accepting larger fragmented messages', async (t) => {
  await t.test('oversized frame', async (subtest) => {
    const server = await fixture(subtest);
    const client = await clientFor(subtest, server);
    const pending = assert.rejects(client.receive(1000), hasError('WebSocket', /16 MiB limit/));
    server.sockets[0].send(Buffer.alloc(MAX_WEBSOCKET_FRAME_BYTES + 1));
    await pending;
  });
  await t.test('17 MiB fragmented message', async (subtest) => {
    const server = await fixture(subtest);
    const client = await clientFor(subtest, server);
    const pending = client.receive(2000);
    server.sockets[0].send(Buffer.alloc(9 * 1024 * 1024, 3), { fin: false });
    server.sockets[0].send(Buffer.alloc(8 * 1024 * 1024, 5), { fin: true });
    const frame = await pending;
    assert.equal(frame.type, 'binary');
    assert.equal(frame.data.length, 17 * 1024 * 1024);
    assert.equal(frame.data[0], 3);
    assert.equal(frame.data.at(-1), 5);
  });
});

test('AP-033 serde lexical integers, known-field duplicates and Unicode/number validation', () => {
  const cases = [
    '{"messageType":"hello","status":200.0,"uaid":"dummy"}',
    '{"messageType":"hello","status":2e2,"uaid":"dummy"}',
    '{"messageType":"hello","status":200,"status":200,"uaid":"dummy"}',
    '{"messageType":"hello","status":200,"uaid":"first","uaid":"second"}',
    '{"messageType":"hello","status":200,"uaid":"dummy","use_webpush":null,"use_webpush":true}',
    '{"messageType":"notification","channelID":"c","version":"first","version":"second"}',
    '{"messageType":"hello","status":200,"uaid":"dummy","ignored":1e400}',
    '{"messageType":"hello","status":200,"uaid":"\\ud800"}',
  ];
  for (const raw of cases) assert.throws(() => parseResponse(raw), hasError('Json'));
  assert.equal(isPong('{"ignored":1e400}'), false);
  assert.equal(isPong('{"ignored":"\\ud800"}'), false);
  assert.deepEqual(parseResponse('{"messageType":"hello","status":200,"uaid":"dummy","unknown":1,"unknown":2}'), { messageType: 'hello', status: 200, uaid: 'dummy', use_webpush: null, broadcasts: null });
  assert.equal(parseResponse('{"messageType":"hello","status":200,"uaid":"\\ud83d\\ude00","unknown":{"nested":["a,}",{}]}}').uaid, '😀');
  for (const raw of [
    '{"messageType":"hello","status":200,"uaid":"dummy","unknown":"\\ud800","unknown":"safe"}',
    '{"messageType":"hello","status":200,"uaid":"dummy","unknown":1e400,"unknown":1}',
  ]) assert.throws(() => parseResponse(raw), hasError('Json'));
  assert.equal(isPong('{"unknown":"\\ud800","unknown":"safe"}'), false);
  assert.equal(isPong('{"unknown":1e400,"unknown":1}'), false);
  const nested = (depth) => '{"messageType":"hello","status":200,"uaid":"dummy","unknown":' + '['.repeat(depth) + '0' + ']'.repeat(depth) + '}';
  assert.equal(parseResponse(nested(126)).uaid, 'dummy');
  assert.throws(() => parseResponse(nested(127)), hasError('Json'));
  assert.equal(isPong('['.repeat(128) + '0' + ']'.repeat(128)), false);
});

test('AP-034 TCP keepalive 60 seconds and nodelay are configured before the websocket opens', async (t) => {
  const server = await fixture(t);
  const originalKeepalive = net.Socket.prototype.setKeepAlive;
  const originalNoDelay = net.Socket.prototype.setNoDelay;
  const keepaliveCalls = [], nodelayCalls = [];
  net.Socket.prototype.setKeepAlive = function (...args) { keepaliveCalls.push(args); return originalKeepalive.apply(this, args); };
  net.Socket.prototype.setNoDelay = function (...args) { nodelayCalls.push(args); return originalNoDelay.apply(this, args); };
  try {
    const client = await clientFor(t, server);
    assert.ok(keepaliveCalls.some(([enabled, milliseconds]) => enabled === true && milliseconds === 60000));
    assert.ok(nodelayCalls.some(([enabled]) => enabled === true));
    await client.close();
  } finally {
    net.Socket.prototype.setKeepAlive = originalKeepalive;
    net.Socket.prototype.setNoDelay = originalNoDelay;
  }
});

test('AP-035 fragmented messages retain Rust byte limits without a ws-specific fragment-count limit', async (t) => {
  const server = await fixture(t);
  const client = await clientFor(t, server);
  const pending = client.receive(3000);
  const byte = Buffer.from([7]);
  for (let fragment = 0; fragment < 16400; fragment++) server.sockets[0].send(byte, { fin: false });
  server.sockets[0].send(Buffer.from([9]), { fin: true });
  const frame = await pending;
  assert.equal(frame.type, 'binary');
  assert.equal(frame.data.length, 16401);
  assert.equal(frame.data.at(-1), 9);
});

test('AP-036 closing a peer that never responds is bounded and remains idempotent', async (t) => {
  const server = await fixture(t);
  const client = await clientFor(t, server, { requestTimeoutMs: 15 });
  server.requests[0].socket.pause();
  const start = Date.now();
  await client.close();
  assert.ok(Date.now() - start < 1000);
  await client.close();
});
