// Deterministic TEST-ONLY key material. These public vectors are never service credentials.
// Source vectors: ece 2.3.1 src/lib.rs and src/legacy.rs, the crate pinned by legacy Cargo.lock.
import { createCipheriv, createECDH, hkdfSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const fixtureKeys = {
  private_key: [...Buffer.from('ab5757a70dd4a53e553a6bbf71ffefea2874ec07a6b379e3c48f895a02dc33de', 'hex')],
  public_key: [...Buffer.from('042571b2becdfde360551aaf1ed0f4cd366c11cebe555f89bcb7b186a53339173168ece2ebe018597bd30479b86e3c8f8eced577ca59187e9246990db682008b0e', 'hex')],
  auth_secret: [...Buffer.from('05305932a1c7eabe13b6cec9fda48882', 'hex')],
};

/** Independently construct wire messages; there is no dependency on the Node receiver. */
export function encryptFixture(keys, plaintext, options = {}) {
  const legacy = options.legacy ?? false;
  const recordSize = options.recordSize ?? 4096;
  const salt = options.salt ?? Buffer.from('0c6bfaadad67958803092d454676f397', 'hex');
  const sender = createECDH('prime256v1');
  sender.setPrivateKey(options.senderPrivate ?? Buffer.from('c9f58f89813e9f8e872e71f42aa64e1757c9254dcc62b72ddc010bb4043ea11c', 'hex'));
  const senderPublic = sender.getPublicKey();
  const receiverPublic = Buffer.from(keys.public_key);
  const ecdhSecret = sender.computeSecret(receiverPublic);
  const context = Buffer.concat([Buffer.from([0, 65]), receiverPublic, Buffer.from([0, 65]), senderPublic]);
  const ikmInfo = legacy ? Buffer.from('Content-Encoding: auth\0') : Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, Buffer.from(keys.auth_secret), ikmInfo, 32));
  const contentInfo = (encoding) => legacy
    ? Buffer.concat([Buffer.from(`Content-Encoding: ${encoding}\0P-256\0`), context])
    : Buffer.from(`Content-Encoding: ${encoding}\0`);
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, contentInfo(legacy ? 'aesgcm' : 'aes128gcm'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, contentInfo('nonce'), 12));
  const content = Buffer.from(plaintext);
  let records = options.records;
  if (records === undefined && legacy) {
    const pad = Buffer.alloc(2 + (options.padding ?? 0));
    pad.writeUInt16BE(pad.length - 2);
    records = [Buffer.concat([pad, content])];
  } else if (records === undefined) {
    records = [];
    for (let offset = 0; offset < content.length || (content.length === 0 && offset === 0); offset += recordSize - 17) {
      const chunk = content.subarray(offset, offset + recordSize - 17);
      const final = offset + chunk.length === content.length;
      records.push(Buffer.concat([chunk, Buffer.from([final ? 2 : 1]), Buffer.alloc(options.padding ?? 0)]));
      if (final) break;
    }
  }
  const ciphertext = records.map((padded, sequence) => {
    const iv = Buffer.from(nonce);
    iv.writeBigUInt64BE(iv.readBigUInt64BE(4) ^ BigInt(sequence), 4);
    const cipher = createCipheriv('aes-128-gcm', key, iv);
    return Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  });
  let body;
  let headers;
  if (legacy) {
    body = Buffer.concat(ciphertext);
    headers = { encoding: 'aesgcm', crypto_key: `dh=${senderPublic.toString('base64url')}`, encryption: `salt=${salt.toString('base64url')};rs=${recordSize}` };
  } else {
    const header = Buffer.alloc(21);
    salt.copy(header);
    header.writeUInt32BE(recordSize, 16);
    header[20] = senderPublic.length;
    body = Buffer.concat([header, senderPublic, ...ciphertext]);
    headers = { encoding: 'aes128gcm' };
  }
  const text = content.toString('utf8');
  let expectedPayload;
  try { expectedPayload = JSON.parse(text); } catch { expectedPayload = { raw: text }; }
  return { data: body.toString('base64url'), headers, expected_plaintext_hex: content.toString('hex'), expected_payload: expectedPayload };
}

export function makeFixtures() {
  const cases = [];
  const add = (id, fixture, overrides = {}) => cases.push({ id, ...fixture, ...overrides });
  const valid = encryptFixture(fixtureKeys, 'When I grow up, I want to be a watermelon');
  const published = '0c6bfaadad67958803092d454676f397000010004104fe33f4ab0dea71914db55823f73b54948f41306d920732dbb9a59a53286482200e597a7b7bc260ba1c227998580992e93973002f3012a28ae8f06bbb78e5ec0ff297de5b429bba7153d3a4ae0caa091fd425f3b4b5414add8ab37a19c1bbb05cf5cb5b2a2e0562d558635641ec52812c6c8ff42e95ccb86be7cd';
  if (Buffer.from(valid.data, 'base64url').toString('hex') !== published) throw new Error('Fixture writer disagrees with pinned ece RFC vector');
  add('aes128gcm-published-rfc-vector', valid);
  add('aes128gcm-missing-headers', valid, { headers: null });
  add('aes128gcm-empty-headers', valid, { headers: {} });
  add('aes128gcm-case-sensitive-encoding-header', valid, { headers: { Encoding: 'unsupported' } });
  add('aes128gcm-json-unicode', encryptFixture(fixtureKeys, '{"title":"通知","body":"🪽","nested":[true,null,12]}'));
  add('aes128gcm-raw-text', encryptFixture(fixtureKeys, 'plain text notification'));
  add('aes128gcm-json-null', encryptFixture(fixtureKeys, 'null'));
  add('aes128gcm-json-number', encryptFixture(fixtureKeys, '123'));
  for (const [id, json] of [
    ['json-u64', '{"id":18446744073709551615}'],
    ['json-i64', '{"min":-9223372036854775808,"max":9223372036854775807}'],
    ['json-negative-zero', '-0'],
  ]) {
    add(id, encryptFixture(fixtureKeys, json), { expected_payload_json: json === '-0' ? '-0.0' : json });
    delete cases.at(-1).expected_payload;
  }
  for (const [id, json] of [
    ['json-out-of-range-float', '{"value":1e400}'],
    ['json-unpaired-surrogate-value', '{"value":"\\ud800"}'],
    ['json-unpaired-surrogate-key', '{"\\udfff":1}'],
    ['json-rust-recursion-limit', `${'['.repeat(128)}0${']'.repeat(128)}`],
  ]) add(id, encryptFixture(fixtureKeys, json), { expected_payload: { raw: json } });
  add('json-rust-maximum-depth', encryptFixture(fixtureKeys, `${'['.repeat(127)}0${']'.repeat(127)}`));
  add('json-surrogate-pair', encryptFixture(fixtureKeys, '{"value":"\\ud83d\\ude07"}'));
  add('aes128gcm-leading-bom-raw', encryptFixture(fixtureKeys, '\uFEFF{"id":1}'));
  add('aes128gcm-padding', encryptFixture(fixtureKeys, 'padded payload', { padding: 32 }));
  add('aes128gcm-empty-final-record', encryptFixture(fixtureKeys, Buffer.alloc(0)));
  add('aes128gcm-multiple-records', encryptFixture(fixtureKeys, 'multiple record plaintext; each record uses its own nonce', { recordSize: 24 }));
  add('aes128gcm-counter-more-than-255', encryptFixture(fixtureKeys, Buffer.alloc(300, 65), { recordSize: 18 }));
  add('aes128gcm-huge-advertised-rs', encryptFixture(fixtureKeys, 'bounded by actual data', { recordSize: 0xffffffff }));

  const error = (id, data = valid.data, headers = valid.headers, message, keys) => add(id, { data, headers }, {
    ...(keys === undefined ? {} : { keys }), expected_error: 'Decryption', ...(message === undefined ? {} : { expected_message: message }),
  });
  error('unsupported-encoding', valid.data, { encoding: 'br' }, 'unsupported encoding');
  error('empty-encoding', valid.data, { encoding: '' }, 'unsupported encoding');
  error('case-sensitive-encoding-value', valid.data, { encoding: 'AES128GCM' }, 'unsupported encoding');
  error('base64-padding-rejected', `${valid.data}=`);
  error('base64-standard-alphabet-rejected', 'a+b/');
  error('base64-whitespace-rejected', `${valid.data}\n`);
  error('base64-invalid-length', 'A');
  error('base64-noncanonical-trailing-bits', 'AB');
  error('empty-ciphertext', '', null, 'aes128gcm decryption failed: Zero-length ciphertext');
  error('short-header', Buffer.alloc(20).toString('base64url'), null, 'aes128gcm decryption failed: Invalid header size (too short)');
  const mutateBody = (callback) => { const buffer = Buffer.from(valid.data, 'base64url'); callback(buffer); return buffer.toString('base64url'); };
  error('truncated-key-header', mutateBody((b) => b[20] = 255), null, 'aes128gcm decryption failed: Invalid header size (too short)');
  error('invalid-record-size', mutateBody((b) => b.writeUInt32BE(17, 16)), null, 'aes128gcm decryption failed: Invalid record size');
  error('header-only', Buffer.from(valid.data, 'base64url').subarray(0, 86).toString('base64url'), null, 'aes128gcm decryption failed: Zero-length ciphertext');
  error('short-key-id', mutateBody((b) => b[20] = 64), null, 'aes128gcm decryption failed: Invalid key length');
  error('short-record', Buffer.from(valid.data, 'base64url').subarray(0, 102).toString('base64url'), null, 'aes128gcm decryption failed: Block too short');
  error('truncated-authentication-tag', Buffer.from(valid.data, 'base64url').subarray(0, -1).toString('base64url'));
  error('tampered-ciphertext', mutateBody((b) => b[90] ^= 1));
  error('wrong-auth', valid.data, null, undefined, { ...fixtureKeys, auth_secret: Array(16).fill(0) });
  const alternate = createECDH('prime256v1'); alternate.setPrivateKey(Buffer.alloc(32, 1));
  error('wrong-keypair', valid.data, null, undefined, { ...fixtureKeys, private_key: [...alternate.getPrivateKey()], public_key: [...alternate.getPublicKey()] });
  error('short-auth', valid.data, null, 'aes128gcm decryption failed: Invalid auth secret', { ...fixtureKeys, auth_secret: fixtureKeys.auth_secret.slice(1) });
  error('invalid-sender-point', mutateBody((b) => b[21] = 0));
  error('invalid-padding-delimiter', encryptFixture(fixtureKeys, '', { records: [Buffer.from([65, 3])] }).data, null, 'aes128gcm decryption failed: Invalid decryption padding');
  error('all-zero-padding', encryptFixture(fixtureKeys, '', { records: [Buffer.alloc(3)] }).data, null, 'aes128gcm decryption failed: Invalid decryption padding');
  error('missing-final-marker', encryptFixture(fixtureKeys, '', { records: [Buffer.from([65, 1])] }).data, null, 'aes128gcm decryption failed: Truncated ciphertext');
  error('early-final-record', encryptFixture(fixtureKeys, '', { recordSize: 18, records: [Buffer.from([65, 2]), Buffer.from([66, 2])] }).data, null, 'aes128gcm decryption failed: Invalid decryption padding');
  const invalidUtf8 = encryptFixture(fixtureKeys, Buffer.from([0xff, 0xfe]));
  add('invalid-utf8-after-decrypt', invalidUtf8, { expected_error: 'Decryption' });
  delete cases.at(-1).expected_payload;

  const legacy = encryptFixture(fixtureKeys, '{"legacy":true}', { legacy: true });
  add('aesgcm-json', legacy);
  add('aesgcm-padded', encryptFixture(fixtureKeys, 'legacy padded text', { legacy: true, padding: 100 }));
  add('aesgcm-semicolon-params', legacy, { headers: { ...legacy.headers, crypto_key: `p256ecdsa=irrelevant;  ${legacy.headers.crypto_key}  `, encryption: `other=1; ${legacy.headers.encryption}` } });
  add('aesgcm-first-matching-param', legacy, { headers: { ...legacy.headers, crypto_key: `${legacy.headers.crypto_key};dh=wrong` } });
  add('aesgcm-ignores-rs-header', legacy, { headers: { ...legacy.headers, encryption: legacy.headers.encryption.replace(';rs=4096', ';rs=18') } });
  add('aesgcm-max-compatible-record', encryptFixture(fixtureKeys, Buffer.alloc(4109, 65), { legacy: true }));
  const legacyError = (id, headers, data = legacy.data, message) => error(id, data, headers, message);
  legacyError('aesgcm-missing-crypto-key', { encoding: 'aesgcm', encryption: legacy.headers.encryption }, undefined, "missing required header for param 'dh'");
  legacyError('aesgcm-missing-dh', { ...legacy.headers, crypto_key: 'p256ecdsa=abc' }, undefined, "param 'dh' not found in header");
  legacyError('aesgcm-missing-encryption', { encoding: 'aesgcm', crypto_key: legacy.headers.crypto_key }, undefined, "missing required header for param 'salt'");
  legacyError('aesgcm-missing-salt', { ...legacy.headers, encryption: 'rs=4096' }, undefined, "param 'salt' not found in header");
  legacyError('aesgcm-hyphen-header-rejected', { encoding: 'aesgcm', 'crypto-key': legacy.headers.crypto_key, encryption: legacy.headers.encryption });
  legacyError('aesgcm-quoted-dh-rejected', { ...legacy.headers, crypto_key: `dh="${legacy.headers.crypto_key.slice(3)}"` });
  legacyError('aesgcm-padded-base64-dh-rejected', { ...legacy.headers, crypto_key: `${legacy.headers.crypto_key}=` });
  legacyError('aesgcm-invalid-salt-base64', { ...legacy.headers, encryption: 'salt=*' });
  legacyError('aesgcm-invalid-salt-length', { ...legacy.headers, encryption: 'salt=AA' }, undefined, 'aesgcm decryption failed: Invalid salt');
  legacyError('aesgcm-empty-body', legacy.headers, '', 'aesgcm decryption failed: Block too short');
  legacyError('aesgcm-tag-only', legacy.headers, Buffer.alloc(16).toString('base64url'), 'aesgcm decryption failed: Block too short');
  legacyError('aesgcm-short-block', legacy.headers, Buffer.alloc(18).toString('base64url'), 'aesgcm decryption failed: Block too short');
  legacyError('aesgcm-multiple-record-limit', legacy.headers, encryptFixture(fixtureKeys, Buffer.alloc(4110, 65), { legacy: true }).data, 'aesgcm decryption failed: Decryption across multiple records is not supported');
  legacyError('aesgcm-empty-plaintext', legacy.headers, encryptFixture(fixtureKeys, '', { legacy: true, padding: 1 }).data, 'aesgcm decryption failed: Invalid decryption padding');
  legacyError('aesgcm-nonzero-padding', legacy.headers, encryptFixture(fixtureKeys, '', { legacy: true, records: [Buffer.from([0, 1, 1, 65])] }).data, 'aesgcm decryption failed: Invalid decryption padding');
  legacyError('aesgcm-excess-padding-length', legacy.headers, encryptFixture(fixtureKeys, '', { legacy: true, records: [Buffer.from([0, 8, 0, 65])] }).data, 'aesgcm decryption failed: Invalid decryption padding');

  const legacyKeys = {
    private_key: [...Buffer.from('f455a5d79fd05100160da0f7937979d19059409e1abb6ec5d55e05d2e2d20ff3', 'hex')],
    public_key: [...Buffer.from('042124063ccbf19dc2fa88b643ba04e6dd8da7ea7ba2c8c62e0f77a943f4c2fa914f6d44116c9fd1c40341c6a440cab3e2140a60e4378a5da735972de078005105', 'hex')],
    auth_secret: [...Buffer.from('476f6f20676f6f206727206a6f6f6221', 'hex')],
  };
  add('aesgcm-published-ietf-vector', {
    data: Buffer.from('ea7a80414304f2136ac39277925f1ca55549ca55ca62a64e7ac7991bc52e78aa40', 'hex').toString('base64url'),
    headers: { encoding: 'aesgcm', crypto_key: `dh=${Buffer.from('04da110db6fce091a6f20e59e42171bab4aab17589d7522d7d71166152c4f3963b0989038d7b0811ce1aab161a4351bc06a917089e833e90eb5ad7568ff9ae8075', 'hex').toString('base64url')}`, encryption: `salt=${Buffer.from('96781aadbc8a7cca22f59ef9c585e692', 'hex').toString('base64url')}` },
    expected_plaintext_hex: Buffer.from('I am the walrus').toString('hex'), expected_payload: { raw: 'I am the walrus' }, keys: legacyKeys,
  });
  return {
    schema_version: 1,
    provenance: ['Synthetic TEST-ONLY keys and deterministic ciphertext.', 'Published independent vectors from the pinned ece 2.3.1 crate: https://docs.rs/crate/ece/2.3.1/source/src/lib.rs and /src/legacy.rs.'],
    keys: fixtureKeys,
    cases,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  writeFileSync(new URL('./crypto-golden.json', import.meta.url), `${JSON.stringify(makeFixtures(), null, 2)}\n`);
}
