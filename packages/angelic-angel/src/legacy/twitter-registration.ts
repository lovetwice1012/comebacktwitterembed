import type { TwitterConfig, Registration } from '../config.js';
import { AngelicAngelError } from '../errors.js';
import { parseSerdeJson } from '../json.js';
const TWITTER_API_URL = 'https://x.com/i/api/1.1/notifications/settings/login.json';
const AUTHORIZATION_BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
export interface LegacyOptions { allowLegacyX?: boolean; endpoint?: string; signal?: AbortSignal; timeoutMs?: number }
export function assertLegacyPermission(options: LegacyOptions = {}): void {
  if (options.allowLegacyX !== true) throw new AngelicAngelError('TwitterApi', 'legacy X registration is disabled; explicit per-run authorization is required');
}
export function buildRegistrationRequest(twitter: TwitterConfig, subscription: Registration): { headers: Record<string, string>; body: unknown } {
  return {
    headers: {
      Authorization: AUTHORIZATION_BEARER, 'x-csrf-token': twitter.ct0,
      'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en', 'Content-Type': 'application/json',
      Cookie: `auth_token=${twitter.auth_token}; ct0=${twitter.ct0}`
    },
    body: { push_device_info: {
      os_version: 'Mac/Firefox', udid: 'Mac/Firefox', env: 3, locale: 'en', protocol_version: 1,
      token: subscription.endpoint,
      encryption_key1: Buffer.from(subscription.keys.public_key).toString('base64url'),
      encryption_key2: Buffer.from(subscription.keys.auth_secret).toString('base64url')
    } }
  };
}
export async function register(twitter: TwitterConfig, subscription: Registration, options: LegacyOptions = {}): Promise<void> {
  assertLegacyPermission(options);
  // Test endpoint injection is restricted to loopback. Credentials never follow redirects.
  const endpoint = options.endpoint ?? TWITTER_API_URL;
  const url = new URL(endpoint);
  if (endpoint !== TWITTER_API_URL && (!['127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol !== 'http:')) {
    throw new AngelicAngelError('TwitterApi', 'test registration endpoint must be loopback HTTP');
  }
  const request = buildRegistrationRequest(twitter, subscription);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  try {
    const response = await fetch(endpoint, { method: 'POST', ...request, body: JSON.stringify(request.body), redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
    if (!response.ok) { await response.body?.cancel(); throw new AngelicAngelError('TwitterApi', `push subscription registration failed (${response.status})`); }
    const bytes = await response.arrayBuffer();
    parseSerdeJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch (cause) {
    if (cause instanceof AngelicAngelError) throw cause;
    throw new AngelicAngelError('Http', 'legacy registration request failed', { cause });
  }
}
