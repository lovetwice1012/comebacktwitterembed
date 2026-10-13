import assert from 'node:assert/strict';
import { createECDH, ECDH } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeBase64UrlNoPad, decryptEce, decryptNotification, parseHeaderParam } from '../dist/crypto.js';
import { generateKeys, subscribe } from '../dist/push.js';
import { AngelicAngelError } from '../dist/errors.js';
import { parseSerdeJson, validateSerdeJsonLexemes } from '../dist/json.js';
import { encryptFixture, makeFixtures } from './fixtures/crypto-fixture-builder.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/crypto-golden.json', import.meta.url), 'utf8'));
const decryptionError = (error) => error instanceof AngelicAngelError && error.code === 'Decryption';

test('checked-in ciphertext matches reproducible independent fixture builder', () => {
  assert.deepEqual(fixture, makeFixtures());
});

for (const vector of fixture.cases) {
  test(`ECE compatibility: ${vector.id}`, () => {
    const keys = vector.keys ?? fixture.keys;
    if (vector.expected_plaintext_hex !== undefined) {
      assert.equal(decryptEce(Buffer.from(vector.data, 'base64url'), vector.headers, keys).toString('hex'), vector.expected_plaintext_hex);
    }
    if (vector.expected_error) {
      assert.throws(() => decryptNotification(vector.data, vector.headers, keys), (error) => {
        assert.ok(decryptionError(error), `expected Decryption error, received ${error}`);
        if (vector.expected_message !== undefined) assert.equal(error.message, `decryption error: ${vector.expected_message}`);
        return true;
      });
    } else {
      const payload = decryptNotification(vector.data, vector.headers, keys);
      if (vector.expected_payload_json !== undefined) assert.equal(JSON.stringify(payload), vector.expected_payload_json);
      else assert.deepEqual(payload, vector.expected_payload);
    }
  });
}

test('fresh key generation has Rust-compatible fixed lengths and valid public/private relationship', () => {
  const previous = new Set();
  for (let index = 0; index < 100; index++) {
    const keys = generateKeys();
    assert.equal(keys.public_key.length, 65);
    assert.equal(keys.public_key[0], 4);
    assert.equal(keys.private_key.length, 32);
    assert.equal(keys.auth_secret.length, 16);
    assert.ok(Object.values(keys).every((bytes) => bytes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)));
    const pair = createECDH('prime256v1'); pair.setPrivateKey(Buffer.from(keys.private_key));
    assert.deepEqual([...pair.getPublicKey()], keys.public_key);
    assert.ok(!previous.has(Buffer.from(keys.public_key).toString('hex')));
    previous.add(Buffer.from(keys.public_key).toString('hex'));
    for (const legacy of [false, true]) {
      const wire = encryptFixture(keys, '{"roundtrip":true}', { legacy });
      assert.deepEqual(decryptNotification(wire.data, wire.headers, keys), { roundtrip: true });
    }
  }
});

test('configured compressed receiver public keys are normalized like the Rust OpenSSL importer', () => {
  const valid = fixture.cases.find((item) => item.id === 'aes128gcm-published-rfc-vector');
  const compressed = [...ECDH.convertKey(Buffer.from(fixture.keys.public_key), 'prime256v1', undefined, undefined, 'compressed')];
  assert.deepEqual(decryptNotification(valid.data, valid.headers, { ...fixture.keys, public_key: compressed }), valid.expected_payload);
});

test('malformed receiver key components become Decryption errors', () => {
  const valid = fixture.cases[0];
  for (const overrides of [{ private_key: [] }, { private_key: Array(32).fill(0) }, { public_key: [] }, { public_key: [4, 1, 2] }]) {
    assert.throws(() => decryptNotification(valid.data, valid.headers, { ...fixture.keys, ...overrides }), decryptionError);
  }
});

test('semicolon parameter parsing preserves names, whitespace, equals and first-match behavior', () => {
  assert.equal(parseHeaderParam('other=1; dh=abc=def ; dh=second', 'dh'), 'abc=def');
  assert.equal(parseHeaderParam('dh=', 'dh'), '');
  assert.equal(parseHeaderParam('\u0085dh=abc\u0085', 'dh'), 'abc');
  assert.throws(() => parseHeaderParam(undefined, 'dh'), decryptionError);
  for (const header of ['DH=abc', 'dh =abc', 'other=abc', '', '\uFEFFdh=abc']) assert.throws(() => parseHeaderParam(header, 'dh'), decryptionError);
});

test('strict no-pad base64url rejects alternate spellings accepted by Buffer', () => {
  for (const value of ['a', 'AA=', 'AA==', 'AB', 'AAB', 'a+b/', ' AA', 'AA\n', 'é']) assert.throws(() => decodeBase64UrlNoPad(value));
  for (const value of ['', 'AA', 'AAA', 'AAAA', '_w', '-_8']) assert.equal(decodeBase64UrlNoPad(value).toString('base64url'), value);
});

test('notification diagnostics never reflect arbitrary header or encoding contents', () => {
  const secret = 'auth_token=secret-should-never-appear';
  const valid = fixture.cases[0];
  for (const headers of [
    { encoding: secret },
    { encoding: 'aesgcm', crypto_key: secret },
    { encoding: 'aesgcm', crypto_key: 'dh=AA', encryption: secret },
  ]) {
    assert.throws(() => decryptNotification(valid.data, headers, fixture.keys), (error) => {
      assert.ok(decryptionError(error));
      assert.ok(!error.message.includes(secret));
      assert.ok(!JSON.stringify(error).includes(secret));
      return true;
    });
  }
});

test('shared Rust JSON parser validates all tokens including overwritten object fields', () => {
  for (const text of ['{"value":1e400,"value":1}', '{"value":"\\ud800","value":"ok"}', '{"\\udfff":1,"value":1}']) {
    assert.throws(() => parseSerdeJson(text), SyntaxError);
    const wire = encryptFixture(fixture.keys, text);
    assert.deepEqual(decryptNotification(wire.data, wire.headers, fixture.keys), { raw: text });
  }
  assert.deepEqual(parseSerdeJson('{"value":1,"value":2}'), { value: 2 });
  assert.doesNotThrow(() => validateSerdeJsonLexemes(`${'['.repeat(127)}0${']'.repeat(127)}`));
  assert.throws(() => parseSerdeJson(`${'['.repeat(128)}0${']'.repeat(128)}`), SyntaxError);
  assert.equal(JSON.stringify(parseSerdeJson('18446744073709551615')), '18446744073709551615');
  assert.equal(typeof parseSerdeJson('18446744073709551615', false), 'number');
  for (const text of ['1.1', '1e3', '-1.2e-3', '{"a":"1e400","b":[0]}']) assert.doesNotThrow(() => parseSerdeJson(text));
});

test('subscribe registers the fresh generated key set and returns the Rust subscription shape', async () => {
  let calledKeys;
  const subscription = await subscribe(async (keys) => {
    calledKeys = keys;
    return { uaid: 'fixture-uaid', channel_id: 'fixture-channel', endpoint: 'https://example.invalid/fixture' };
  });
  assert.deepEqual(subscription, { keys: calledKeys, autopush: { uaid: 'fixture-uaid', channel_id: 'fixture-channel' }, endpoint: 'https://example.invalid/fixture' });
});

test('subscribe retains the Rust AutoPush error category without exposing cause secrets', async () => {
  const cause = new Error('fixture auth_token=secret-should-never-appear');
  await assert.rejects(subscribe(async () => { throw cause; }), (error) => {
    assert.ok(error instanceof AngelicAngelError);
    assert.equal(error.code, 'AutoPush');
    assert.equal(error.message, 'AutoPush error: AutoPush registration failed');
    assert.ok(error.cause instanceof Error);
    assert.ok(!JSON.stringify(error).includes('secret-should-never-appear'));
    return true;
  });
});
