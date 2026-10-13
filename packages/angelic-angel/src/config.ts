import { readFile, writeFile, rename, copyFile, chmod, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { AngelicAngelError } from './errors.js';
export interface TwitterConfig { auth_token: string; ct0: string }
export interface WebPushKeys { public_key: number[]; private_key: number[]; auth_secret: number[] }
export interface AutoPushSession { uaid: string; channel_id: string }
export interface Registration { endpoint: string; autopush: AutoPushSession; keys: WebPushKeys }
export interface Config { twitter: TwitterConfig; registration?: Registration }
export const DEFAULT_CONFIG_PATH = 'angelic-angel.toml';
function invalid(): never { throw new AngelicAngelError('Toml', 'invalid configuration field types or missing required fields'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string { return typeof value === 'string' ? value : invalid(); }
function bytes(value: unknown, fromToml = false): number[] {
  if (!Array.isArray(value) || !value.every(item => fromToml
    ? typeof item === 'bigint' && item >= 0n && item <= 255n
    : Number.isInteger(item) && item >= 0 && item <= 255)) return invalid();
  return value.map(Number);
}
function validateUnicode(value: unknown): void {
  if (typeof value === 'string' && !value.isWellFormed()) return invalid();
  if (Array.isArray(value)) for (const item of value) validateUnicode(item);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (!key.isWellFormed()) return invalid();
    validateUnicode(item);
  }
}
export function validateConfig(value: unknown, fromToml = false): Config {
  const input = record(value), twitter = record(input.twitter);
  const config: Config = { twitter: { auth_token: string(twitter.auth_token), ct0: string(twitter.ct0) } };
  if (input.registration !== undefined) {
    const registration = record(input.registration), autopush = record(registration.autopush), keys = record(registration.keys);
    config.registration = {
      endpoint: string(registration.endpoint),
      autopush: { uaid: string(autopush.uaid), channel_id: string(autopush.channel_id) },
      keys: { public_key: bytes(keys.public_key, fromToml), private_key: bytes(keys.private_key, fromToml), auth_secret: bytes(keys.auth_secret, fromToml) }
    };
  }
  return config;
}
export function parseConfig(content: string): Config {
  try {
    if (!content.isWellFormed()) return invalid();
    const parsed = parse(content, { integersAsBigInt: true });
    validateUnicode(parsed);
    return validateConfig(parsed, true);
  }
  catch (cause) {
    if (cause instanceof AngelicAngelError) throw cause;
    throw new AngelicAngelError('Toml', 'failed to parse configuration', { cause });
  }
}
export function stringifyConfig(config: Config): string { return stringify(validateConfig(config)); }
export async function loadConfig(path: string): Promise<Config> {
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(path)); }
  catch (cause) { throw new AngelicAngelError('Config', 'failed to read config', { cause }); }
  return parseConfig(content);
}
/** Atomic replacement, private permissions and recoverable backup preserve old credentials. */
export async function saveConfig(config: Config, path: string): Promise<void> {
  const content = stringifyConfig(config), temporary = `${path}.tmp-${randomUUID()}`;
  try {
    try {
      const backup = `${path}.bak-${Date.now()}-${randomUUID()}`;
      await copyFile(path, backup);
      await chmod(backup, 0o600);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (cause) {
    throw new AngelicAngelError('Io', 'failed to save configuration', { cause });
  } finally { await unlink(temporary).catch(() => undefined); }
}
export function getWebhookEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WEBHOOK_ENDPOINT === undefined) throw new AngelicAngelError('Config', 'WEBHOOK_ENDPOINT environment variable is not set');
  return env.WEBHOOK_ENDPOINT;
}
