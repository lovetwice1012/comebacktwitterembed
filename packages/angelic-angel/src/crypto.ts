import { createDecipheriv, createECDH, ECDH, hkdfSync } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { WebPushKeys } from './config.js';
import { AngelicAngelError } from './errors.js';
import { parseSerdeJson } from './json.js';

export type NotificationHeaders = Record<string, string> | null | undefined;

// The protocol here follows the pinned ece 2.3.1 crate used by the Rust baseline.
// AES, ECDH and HKDF are implemented by Node's OpenSSL-backed crypto APIs.
const TAG_LENGTH = 16;
const PUBLIC_KEY_LENGTH = 65;
const AUTH_LENGTH = 16;
const SALT_LENGTH = 16;

function fail(message: string, cause?: unknown): never {
  throw new AngelicAngelError('Decryption', message, cause === undefined ? undefined : { cause });
}

/** Node's Buffer decoder is permissive; Rust URL_SAFE_NO_PAD also checks trailing bits. */
export function decodeBase64UrlNoPad(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) {
    const offset = value.search(/[^A-Za-z0-9_-]/u);
    throw new Error(`Invalid byte ${Buffer.from(value.slice(offset, offset + 1))[0]}, offset ${offset}.`);
  }
  if (value.length % 4 === 1) throw new Error(`Invalid input length: ${value.length}`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new Error(`Invalid last symbol ${value.charCodeAt(value.length - 1)}, offset ${value.length - 1}.`);
  }
  return decoded;
}

/** The baseline uses exact header/parameter names and the first semicolon-delimited match. */
export function parseHeaderParam(headerValue: string | undefined, paramName: string): string {
  if (headerValue === undefined) fail(`missing required header for param '${paramName}'`);
  const prefix = `${paramName}=`;
  for (const segment of headerValue.split(';')) {
    // Rust str::trim uses Unicode White_Space (includes U+0085, excludes U+FEFF).
    const part = segment.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
    if (part.startsWith(prefix)) return part.slice(prefix.length);
  }
  fail(`param '${paramName}' not found in header`);
}

function deriveKeyAndNonce(
  keys: WebPushKeys,
  senderPublic: Buffer,
  salt: Buffer,
  legacy: boolean,
): { key: Buffer; nonce: Buffer } {
  if (keys.auth_secret.length !== AUTH_LENGTH) throw new Error('Invalid auth secret');
  if (salt.length !== SALT_LENGTH) throw new Error('Invalid salt');

  const receiver = createECDH('prime256v1');
  receiver.setPrivateKey(Buffer.from(keys.private_key));
  // Rust imports the configured public component independently of the private scalar,
  // then exports that component in uncompressed format for the KDF context.
  const receiverPublic = Buffer.from(ECDH.convertKey(Buffer.from(keys.public_key), 'prime256v1', undefined, undefined, 'uncompressed'));
  const sharedSecret = receiver.computeSecret(senderPublic);
  let ikmInfo: Buffer;
  let keyInfo: Buffer;
  let nonceInfo: Buffer;
  if (legacy) {
    if (senderPublic.length !== PUBLIC_KEY_LENGTH) throw new Error('Invalid key length');
    const publicContext = Buffer.concat([Buffer.from([0, 65]), receiverPublic, Buffer.from([0, 65]), senderPublic]);
    ikmInfo = Buffer.from('Content-Encoding: auth\0');
    keyInfo = Buffer.concat([Buffer.from('Content-Encoding: aesgcm\0P-256\0'), publicContext]);
    nonceInfo = Buffer.concat([Buffer.from('Content-Encoding: nonce\0P-256\0'), publicContext]);
  } else {
    ikmInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublic, senderPublic]);
    keyInfo = Buffer.from('Content-Encoding: aes128gcm\0');
    nonceInfo = Buffer.from('Content-Encoding: nonce\0');
  }
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, Buffer.from(keys.auth_secret), ikmInfo, 32));
  return {
    key: Buffer.from(hkdfSync('sha256', ikm, salt, keyInfo, 16)),
    nonce: Buffer.from(hkdfSync('sha256', ikm, salt, nonceInfo, 12)),
  };
}

function decryptRecord(ciphertext: Buffer, key: Buffer, nonce: Buffer, sequence: number): Buffer {
  if (ciphertext.length <= TAG_LENGTH) throw new Error('Block too short');
  const iv = Buffer.from(nonce);
  iv.writeBigUInt64BE(iv.readBigUInt64BE(4) ^ BigInt(sequence), 4);
  const decipher = createDecipheriv('aes-128-gcm', key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_LENGTH));
  return Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_LENGTH)), decipher.final()]);
}

function decryptAes128Gcm(encrypted: Buffer, keys: WebPushKeys): Buffer {
  if (encrypted.length === 0) throw new Error('Zero-length ciphertext');
  if (encrypted.length < 21) throw new Error('Invalid header size (too short)');
  const keyLength = encrypted[20]!;
  const headerLength = 21 + keyLength;
  if (encrypted.length < headerLength) throw new Error('Invalid header size (too short)');
  const recordSize = encrypted.readUInt32BE(16);
  if (recordSize < 18) throw new Error('Invalid record size');
  if (encrypted.length === headerLength) throw new Error('Zero-length ciphertext');
  if (keyLength !== PUBLIC_KEY_LENGTH) throw new Error('Invalid key length');
  const { key, nonce } = deriveKeyAndNonce(keys, encrypted.subarray(21, headerLength), encrypted.subarray(0, SALT_LENGTH), false);
  const plaintext: Buffer[] = [];
  let finalSeen = false;
  let sequence = 0;
  for (let offset = headerLength; offset < encrypted.length; offset += recordSize) {
    if (finalSeen) throw new Error('Invalid decryption padding');
    const padded = decryptRecord(encrypted.subarray(offset, Math.min(offset + recordSize, encrypted.length)), key, nonce, sequence++);
    let delimiter = padded.length - 1;
    while (delimiter >= 0 && padded[delimiter] === 0) delimiter--;
    if (delimiter < 0 || (padded[delimiter] !== 1 && padded[delimiter] !== 2)) throw new Error('Invalid decryption padding');
    finalSeen = padded[delimiter] === 2;
    plaintext.push(padded.subarray(0, delimiter));
  }
  if (!finalSeen) throw new Error('Truncated ciphertext');
  return Buffer.concat(plaintext);
}

function decryptAesGcm(encrypted: Buffer, headers: NotificationHeaders, keys: WebPushKeys): Buffer {
  if (headers === null || headers === undefined) fail('aesgcm encoding requires headers but none were provided');
  const dh = parseHeaderParam(headers.crypto_key, 'dh');
  let senderPublic: Buffer;
  try { senderPublic = decodeBase64UrlNoPad(dh); }
  catch (cause) { fail(`failed to base64-decode sender public key: ${String(cause instanceof Error ? cause.message : cause)}`, cause); }
  const saltValue = parseHeaderParam(headers.encryption, 'salt');
  let salt: Buffer;
  try { salt = decodeBase64UrlNoPad(saltValue); }
  catch (cause) { fail(`failed to base64-decode salt: ${String(cause instanceof Error ? cause.message : cause)}`, cause); }
  try {
    const { key, nonce } = deriveKeyAndNonce(keys, senderPublic, salt, true);
    // AesGcmEncryptedBlock::new adds the tag length to the listener's hardcoded 4096.
    // The Rust listener deliberately does not use the encryption header's rs value.
    if (encrypted.length - TAG_LENGTH >= 4096 + TAG_LENGTH) throw new Error('Decryption across multiple records is not supported');
    if (encrypted.length <= TAG_LENGTH + 2) throw new Error('Block too short');
    const padded = decryptRecord(encrypted, key, nonce, 0);
    const padding = padded.readUInt16BE(0);
    if (padding + 2 >= padded.length) throw new Error('Invalid decryption padding');
    for (const byte of padded.subarray(2, padding + 2)) if (byte !== 0) throw new Error('Invalid decryption padding');
    return padded.subarray(padding + 2);
  } catch (cause) {
    fail(`aesgcm decryption failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
  }
}

/** Decode the ECE body without changing encoding/header fallback behavior. */
export function decryptEce(encrypted: Uint8Array, headers: NotificationHeaders, keys: WebPushKeys): Buffer {
  const encoding = headers?.encoding;
  if (encoding === 'aesgcm') return decryptAesGcm(Buffer.from(encrypted), headers, keys);
  if (encoding !== undefined && encoding !== 'aes128gcm') fail('unsupported encoding');
  try { return decryptAes128Gcm(Buffer.from(encrypted), keys); }
  catch (cause) { fail(`aes128gcm decryption failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause); }
}

/** Return the same JSON value or raw-text wrapper that Rust forwards to the webhook. */
export function decryptNotification(data: string, headers: NotificationHeaders, keys: WebPushKeys): unknown {
  let encrypted: Buffer;
  try { encrypted = decodeBase64UrlNoPad(data); }
  catch (cause) { fail(`base64 decode failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause); }
  const decrypted = decryptEce(encrypted, headers, keys);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decrypted); }
  catch (cause) { fail(`UTF-8 conversion failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause); }
  try { return parseSerdeJson(text); }
  catch { return { raw: text }; }
}
