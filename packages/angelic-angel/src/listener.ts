import { setTimeout as delay } from 'node:timers/promises';
import { connectAndListen, AckCode, type AutoPushOptions, type Notification, type ConnectResult } from './autopush.js';
import { loadConfig, saveConfig, getWebhookEndpoint, type Registration, type WebPushKeys } from './config.js';
import { decryptNotification } from './crypto.js';
import { register, assertLegacyPermission, type LegacyOptions } from './legacy/twitter-registration.js';
import { AngelicAngelError } from './errors.js';
export interface NotificationClient {
  nextNotification(): Promise<Notification | null>;
  ack(channelId: string, version: string, code: AckCode): Promise<void>;
  close(): Promise<void>;
}
export interface ListenerOptions {
  signal?: AbortSignal; env?: NodeJS.ProcessEnv; webhookTimeoutMs?: number;
  autopush?: AutoPushOptions; legacy?: LegacyOptions;
  connect?: (registration: Registration, options: AutoPushOptions) => Promise<ConnectResult>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onEvent?: (event: { type: string; code?: string; delaySeconds?: number; retryCount?: number }) => void;
}
export function calcBackoff(retryCount: number): number {
  return Math.min(5 * 2 ** Math.max(0, Math.min(64, retryCount - 1)), 300);
}
export async function sendToWebhook(payload: unknown, options: ListenerOptions = {}): Promise<void> {
  const endpoint = getWebhookEndpoint(options.env);
  const timeout = AbortSignal.timeout(options.webhookTimeoutMs ?? 30_000);
  try {
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const initial = new URL(endpoint);
    const decodeUserInfo = (value: string): string => {
      const bytes: number[] = [];
      for (let index = 0; index < value.length; index++) {
        if (value[index] === '%' && /^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))) {
          bytes.push(parseInt(value.slice(index + 1, index + 3), 16)); index += 2;
        } else bytes.push(value.charCodeAt(index));
      }
      return Buffer.from(bytes).toString('utf8');
    };
    let authorization = initial.username || initial.password
      ? `Basic ${Buffer.from(`${decodeUserInfo(initial.username)}:${decodeUserInfo(initial.password)}`).toString('base64')}` : undefined;
    initial.username = ''; initial.password = '';
    let url = initial.href, method = 'POST', body: string | undefined = JSON.stringify(payload);
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (authorization) headers.Authorization = authorization;
      response = await fetch(url, { method, headers, body, redirect: 'manual', signal });
      if (![301,302,303,307,308].includes(response.status) || !response.headers.has('location')) break;
      const next = new URL(response.headers.get('location')!, url);
      await response.body?.cancel();
      if (redirects >= 10 || !['http:', 'https:'].includes(next.protocol)) throw new AngelicAngelError('Http', 'webhook redirect failed');
      if (next.origin !== new URL(url).origin) authorization = undefined;
      next.username = ''; next.password = '';
      if (response.status === 303 || response.status === 301 || response.status === 302) { method = 'GET'; body = undefined; }
      url = next.href;
    }
    await response.body?.cancel();
    // Explicit correction of Rust's non-2xx ACK100 bug; retained as a tested compatibility delta.
    if (!response.ok) throw new AngelicAngelError('Http', `webhook request failed (${response.status})`);
  } catch (cause) {
    if (cause instanceof AngelicAngelError) throw cause;
    throw new AngelicAngelError('Http', 'webhook request failed', { cause });
  }
}
export async function handleNotificationData(data: string, headers: Record<string, string> | null | undefined, keys: WebPushKeys, options: ListenerOptions = {}): Promise<void> {
  const payload = decryptNotification(data, headers, keys);
  await sendToWebhook(payload, options);
}
export async function processNotification(client: NotificationClient, notification: Notification, keys: WebPushKeys, options: ListenerOptions = {}): Promise<AckCode> {
  let code = AckCode.Delivered;
  if (notification.data !== undefined && notification.data !== null) {
    try { await handleNotificationData(notification.data, notification.headers, keys, options); }
    catch (error) {
      if (options.signal?.aborted) throw error;
      code = error instanceof AngelicAngelError && error.code === 'Decryption' ? AckCode.DecryptionError : AckCode.NotDelivered;
      options.onEvent?.({ type: 'notification_failed', code: error instanceof AngelicAngelError ? error.code : 'Unknown' });
    }
  }
  await client.ack(notification.channel_id, notification.version, code);
  options.onEvent?.({ type: 'ack', code: String(code) });
  return code;
}
export async function tryConnect(registration: Registration, configPath: string, options: ListenerOptions = {}): Promise<NotificationClient> {
  const connect = options.connect ?? ((reg: Registration, opts: AutoPushOptions) => connectAndListen(reg.autopush, reg.keys, opts));
  const connectOptions: AutoPushOptions = { ...options.autopush, signal: options.signal, allowReregistration: options.legacy?.allowLegacyX === true };
  const result = await connect(registration, connectOptions);
  if (result.kind === 'Connected') return result.client;
  assertLegacyPermission(options.legacy);
  const config = await loadConfig(configPath);
  const updated: Registration = { endpoint: result.registration.endpoint,
    autopush: { uaid: result.registration.uaid, channel_id: result.registration.channel_id }, keys: result.keys };
  await register(config.twitter, updated, { ...options.legacy, signal: options.signal });
  options.signal?.throwIfAborted();
  config.registration = updated;
  await saveConfig(config, configPath);
  Object.assign(registration, updated);
  const retry = await connect(registration, connectOptions);
  if (retry.kind === 'Connected') return retry.client;
  throw new AngelicAngelError('AutoPush', 'still failed after re-registration');
}
/** Infinite retries; successful HELLO resets failures; 4774 respects 30 minute delay. */
export async function listen(registration: Registration, configPath: string, options: ListenerOptions = {}): Promise<void> {
  let retryCount = 0;
  const sleep = options.sleep ?? (async (ms: number, signal?: AbortSignal) => { await delay(ms, undefined, { signal }); });
  while (!options.signal?.aborted) {
    let connected = false, client: NotificationClient | undefined;
    let waitSeconds = 1;
    try {
      client = await tryConnect(registration, configPath, options);
      connected = true;
      options.onEvent?.({ type: 'connected' });
      for (;;) {
        const notification = await client.nextNotification();
        if (!notification) break;
        await processNotification(client, notification, registration.keys, options);
      }
      retryCount = 0;
    } catch (error) {
      if (options.signal?.aborted) return;
      const message = error instanceof AngelicAngelError ? error.message : '';
      if (!connected && (message.includes('UAID invalid') || message.includes('still failed after re-registration'))) throw error;
      if (connected) {
        if (message.includes('BACKOFF:')) waitSeconds = 1800;
        else retryCount = 0;
      } else { retryCount += 1; waitSeconds = calcBackoff(retryCount); }
      options.onEvent?.({ type: 'disconnected', code: error instanceof AngelicAngelError ? error.code : 'Unknown' });
    } finally { await client?.close().catch(() => undefined); }
    options.onEvent?.({ type: 'retry', delaySeconds: waitSeconds, retryCount });
    try { await sleep(waitSeconds * 1000, options.signal); }
    catch (cause) { if (options.signal?.aborted) return; throw cause; }
  }
}
