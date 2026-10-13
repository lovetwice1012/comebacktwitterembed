import { randomUUID } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { performance } from 'node:perf_hooks';
import WebSocket, { type ClientOptions, type RawData } from 'ws';
import type { AutoPushSession, WebPushKeys } from './config.js';
import { AngelicAngelError } from './errors.js';
import { generateKeys } from './push.js';
import { parseSerdeJson } from './json.js';

export const AUTOPUSH_WS_URL = 'wss://push.services.mozilla.com/';
export const AUTOPUSH_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:134.0) Gecko/20100101 Firefox/134.0';
export const BACKOFF_WS_STATUS_CODE = 4774;
export const MAX_RECENT_MESSAGE_IDS = 100;
export const MAX_WEBSOCKET_MESSAGE_BYTES = 64 * 1024 * 1024;
export const MAX_WEBSOCKET_FRAME_BYTES = 16 * 1024 * 1024;
export const TWITTER_VAPID_PUBLIC_KEY = Buffer.from([
  4, 94, 104, 18, 141, 49, 13, 74, 96, 202, 82, 131, 78, 91, 29, 242, 150, 102,
  197, 0, 53, 149, 230, 8, 54, 38, 62, 173, 43, 28, 89, 130, 191, 222, 213,
  128, 147, 62, 21, 49, 187, 95, 212, 194, 196, 253, 140, 157, 234, 34, 8,
  234, 143, 158, 221, 15, 83, 8, 222, 111, 100, 204, 213, 48, 75,
]);

export enum AckCode { Delivered = 100, DecryptionError = 101, NotDelivered = 102 }
export interface AckUpdate { channelID: string; version: string; code: number }
export type AutoPushMessage =
  | { messageType: 'hello'; uaid?: string; channelIDs?: string[]; use_webpush: boolean; broadcasts: Record<string, string> }
  | { messageType: 'register'; channelID: string; key?: string }
  | { messageType: 'unregister'; channelID: string; code: number }
  | { messageType: 'ack'; updates: AckUpdate[] };
export interface HelloResponse {
  messageType: 'hello'; status: number; uaid: string;
  use_webpush?: boolean | null; broadcasts?: Record<string, string> | null;
}
export interface RegisterResponse { messageType: 'register'; status: number; pushEndpoint: string; channelID: string }
export interface NotificationResponse {
  messageType: 'notification'; channelID: string; version: string;
  data?: string | null; headers?: Record<string, string> | null;
}
export type AutoPushResponse = HelloResponse | RegisterResponse | NotificationResponse;
export interface Notification {
  channel_id: string; version: string; data: string | null; headers: Record<string, string> | null;
}
export interface AutoPushRegistration { uaid: string; channel_id: string; endpoint: string }
export interface ReregistrationInfo { registration: AutoPushRegistration; keys: WebPushKeys }
export type ConnectResult =
  | { kind: 'Connected'; client: AutoPushClient }
  | ({ kind: 'NeedsReregistration' } & ReregistrationInfo);
export type WsFrame =
  | { type: 'text'; data: string }
  | { type: 'binary' | 'ping' | 'pong'; data: Buffer }
  | { type: 'close'; code: number; reason: string };
type QueuedFrame = WsFrame | { type: 'error'; error: AngelicAngelError };
interface Waiter { resolve: (frame: QueuedFrame | null | undefined) => void; timer?: ReturnType<typeof setTimeout> }

/** Defaults exactly mirror legacy-rust/src/autopush.rs. Short timers and loopback URLs are test injection only. */
export interface AutoPushOptions {
  url?: string;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  appPingIntervalMs?: number;
  wsPingIntervalMs?: number;
  tcpKeepaliveMs?: number;
  /** Legacy UAID recovery mutates the remote subscription and is gated explicitly. */
  allowReregistration?: boolean;
  /** TLS options may be supplied for a local test CA. Certificate verification stays enabled by default. */
  tls?: Pick<tls.ConnectionOptions, 'ca' | 'cert' | 'key' | 'servername'>;
}
type PongWaitResult = { kind: 'pong' | 'closed' | 'timeout' } | { kind: 'notification'; notification: Notification };

export function serializeMessage(message: AutoPushMessage): string { return JSON.stringify(message); }
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function stringMap(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((item) => typeof item === 'string');
}
function statusCode(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535;
}
function parseJson(text: string): unknown {
  // The protocol only interprets u16 status values. Retain ordinary JS numeric
  // primitives here so large JSON integers cannot resemble object-shaped pongs.
  return parseSerdeJson(text, false);
}
/** JSON.parse loses duplicate fields and integer lexical form. Inspect already-valid JSON
 * tokens to retain serde's rejection of duplicate known fields and floating u16 values. */
function topLevelFields(text: string): Array<{ key: string; rawValue: string }> {
  const fields: Array<{ key: string; rawValue: string }> = [];
  let offset = 0;
  const whitespace = (): void => { while (/\s/u.test(text[offset] ?? '') && offset < text.length) offset++; };
  const skipString = (): void => {
    offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '\\') offset++;
      else if (character === '"') return;
    }
  };
  whitespace(); offset++; whitespace();
  while (offset < text.length && text[offset] !== '}') {
    const keyStart = offset;
    skipString();
    const key = JSON.parse(text.slice(keyStart, offset)) as string;
    whitespace(); offset++; whitespace();
    const valueStart = offset;
    let depth = 0;
    while (offset < text.length) {
      const character = text[offset];
      if (character === '"') { skipString(); continue; }
      if (character === '{' || character === '[') depth++;
      else if (character === '}' || character === ']') { if (depth === 0) break; depth--; }
      else if (character === ',' && depth === 0) break;
      offset++;
    }
    fields.push({ key, rawValue: text.slice(valueStart, offset).trim() });
    if (text[offset] === ',') offset++;
    whitespace();
  }
  return fields;
}
function validateSerdeFields(text: string, messageType: unknown): void {
  const knownFields = new Set(['messageType', ...(messageType === 'hello'
    ? ['status', 'uaid', 'use_webpush', 'broadcasts'] : messageType === 'register'
      ? ['status', 'pushEndpoint', 'channelID'] : ['channelID', 'version', 'data', 'headers'])]);
  const seen = new Set<string>();
  for (const { key, rawValue } of topLevelFields(text)) {
    if (!knownFields.has(key)) continue;
    if (seen.has(key) || (key === 'status' && !/^[0-9]+$/u.test(rawValue))) {
      throw new AngelicAngelError('Json', 'invalid AutoPush response structure');
    }
    seen.add(key);
  }
}
/** serde accepts unknown fields but rejects unknown tags, missing fields and incorrect field types. */
export function parseResponse(text: string): AutoPushResponse {
  let value: unknown;
  try { value = parseJson(text); }
  catch (cause) { throw new AngelicAngelError('Json', 'invalid AutoPush JSON', { cause }); }
  if (isObject(value)) {
    validateSerdeFields(text, value.messageType);
    if (value.messageType === 'hello' && statusCode(value.status) && typeof value.uaid === 'string'
      && (value.use_webpush == null || typeof value.use_webpush === 'boolean')
      && (value.broadcasts == null || stringMap(value.broadcasts))) return {
        messageType: 'hello', status: value.status, uaid: value.uaid,
        use_webpush: value.use_webpush as boolean | null | undefined ?? null,
        broadcasts: value.broadcasts as Record<string, string> | null | undefined ?? null,
      };
    if (value.messageType === 'register' && statusCode(value.status)
      && typeof value.pushEndpoint === 'string' && typeof value.channelID === 'string') return {
        messageType: 'register', status: value.status, pushEndpoint: value.pushEndpoint, channelID: value.channelID,
      };
    if (value.messageType === 'notification' && typeof value.channelID === 'string' && typeof value.version === 'string'
      && (value.data == null || typeof value.data === 'string')
      && (value.headers == null || stringMap(value.headers))) return {
        messageType: 'notification', channelID: value.channelID, version: value.version,
        data: value.data as string | null | undefined ?? null,
        headers: value.headers as Record<string, string> | null | undefined ?? null,
      };
  }
  throw new AngelicAngelError('Json', 'invalid AutoPush response structure');
}
export function isPong(text: string): boolean {
  try {
    const value = parseJson(text);
    return isObject(value) && !Object.hasOwn(value, 'messageType');
  } catch { return false; }
}
export function isBackoffClose(code?: number | null): boolean { return code === BACKOFF_WS_STATUS_CODE; }
function notificationOf(response: NotificationResponse): Notification {
  return { channel_id: response.channelID, version: response.version, data: response.data ?? null, headers: response.headers ?? null };
}
function bufferOf(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
}

/** Observe frame headers through the public upgrade socket. ws only exposes an aggregate
 * message limit; tungstenite independently limits each frame to 16 MiB. Payload bytes are
 * skipped without retaining them, including fragmented messages up to the 64 MiB limit. */
function frameSizeGuard(onViolation: () => void): (data: Buffer) => void {
  const header = Buffer.alloc(14);
  let collected = 0, needed = 2, remainingPayload = 0, blocked = false;
  return (data: Buffer): void => {
    if (blocked) return;
    let offset = 0;
    while (offset < data.length) {
      if (remainingPayload > 0) {
        const skip = Math.min(remainingPayload, data.length - offset);
        remainingPayload -= skip; offset += skip;
        continue;
      }
      const copy = Math.min(needed - collected, data.length - offset);
      data.copy(header, collected, offset, offset + copy);
      collected += copy; offset += copy;
      if (collected < needed) continue;
      const lengthTag = (header[1] ?? 0) & 127;
      const extraLength = lengthTag === 126 ? 2 : lengthTag === 127 ? 8 : 0;
      const totalHeader = 2 + extraLength + (((header[1] ?? 0) & 128) ? 4 : 0);
      if (needed < totalHeader) { needed = totalHeader; continue; }
      const payloadLength = lengthTag === 127 ? header.readBigUInt64BE(2)
        : BigInt(lengthTag === 126 ? header.readUInt16BE(2) : lengthTag);
      if (payloadLength > BigInt(MAX_WEBSOCKET_FRAME_BYTES)) {
        blocked = true; onViolation(); return;
      }
      remainingPayload = Number(payloadLength);
      collected = 0; needed = 2;
    }
  };
}

export class AutoPushClient {
  private ws?: WebSocket;
  private readonly queue: QueuedFrame[] = [];
  private waiter?: Waiter;
  private ended = false;
  private closing = false;
  private connectionOpened = false;
  private signal?: AbortSignal;
  private abortHandler?: () => void;
  private readonly recentMessageIds: string[] = [];
  private readonly recentMessageIdsSet = new Set<string>();
  private readonly options: Required<Pick<AutoPushOptions, 'requestTimeoutMs' | 'appPingIntervalMs' | 'wsPingIntervalMs' | 'tcpKeepaliveMs'>> & AutoPushOptions;
  private currentUaid = '';
  private currentChannelId = '';

  constructor(options: AutoPushOptions = {}) {
    this.options = {
      ...options, requestTimeoutMs: options.requestTimeoutMs ?? 10000,
      appPingIntervalMs: options.appPingIntervalMs ?? 300000,
      wsPingIntervalMs: options.wsPingIntervalMs ?? 150000, tcpKeepaliveMs: options.tcpKeepaliveMs ?? 60000,
    };
    for (const key of ['requestTimeoutMs', 'appPingIntervalMs', 'wsPingIntervalMs', 'tcpKeepaliveMs'] as const) {
      if (!Number.isFinite(this.options[key]) || this.options[key] <= 0) {
        throw new AngelicAngelError('Config', 'AutoPush timer must be a positive finite number');
      }
    }
  }
  uaid(): string { return this.currentUaid; }
  channelId(): string { return this.currentChannelId; }
  channel_id(): string { return this.currentChannelId; }
  setSession(session: AutoPushSession): void {
    this.currentUaid = session.uaid;
    this.currentChannelId = session.channel_id;
  }
  private aborted(): AngelicAngelError {
    return new AngelicAngelError('Io', 'operation aborted');
  }
  private enqueue(frame: QueuedFrame): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else this.queue.push(frame);
    // Rust reads the stream only when next() is polled. Pause eager Node delivery
    // between reads to preserve backpressure while decryption/webhook work runs.
    if (!this.closing && this.ws?.readyState === WebSocket.OPEN) this.ws.pause();
  }
  private removeAbortHandler(): void {
    if (this.signal && this.abortHandler) this.signal.removeEventListener('abort', this.abortHandler);
    this.abortHandler = undefined;
  }
  async connect(url: string = this.options.url ?? AUTOPUSH_WS_URL, signal: AbortSignal | undefined = this.options.signal): Promise<void> {
    if (this.ws) throw new AngelicAngelError('AutoPush', 'client already connected');
    if (signal?.aborted) throw this.aborted();
    let parsed: URL;
    try { parsed = new URL(url); }
    catch (cause) { throw new AngelicAngelError('AutoPush', 'failed to build request', { cause }); }
    if (!['ws:', 'wss:'].includes(parsed.protocol) || !parsed.hostname || parsed.hash) {
      throw new AngelicAngelError('AutoPush', 'invalid WebSocket URL');
    }
    // Rust's TCP connection uses port 443 whenever the URL omits a port, even for ws://.
    // Assign it explicitly instead of accepting ws's usual ws:// default port 80.
    const authority = url.match(/^[^:]+:\/\/([^/?#]*)/u)?.[1];
    const explicitPort = authority?.match(/:([0-9]+)$/u)?.[1];
    if (!parsed.port && explicitPort === undefined) parsed.port = '443';
    const secure = parsed.protocol === 'wss:';
    const keepaliveMs = this.options.tcpKeepaliveMs;
    const tlsOptions = this.options.tls;
    const createConnection: NonNullable<ClientOptions['createConnection']> = ((socketOptions: tls.ConnectionOptions & net.NetConnectOpts) => {
      const connectionOptions = { ...socketOptions, ...tlsOptions, path: undefined };
      let socket: net.Socket;
      if (secure) {
        const host = 'host' in connectionOptions ? connectionOptions.host : undefined;
        if (connectionOptions.servername === undefined && typeof host === 'string') {
          connectionOptions.servername = net.isIP(host) ? '' : host;
        }
        socket = tls.connect(connectionOptions);
      } else socket = net.connect(connectionOptions as net.TcpNetConnectOpts);
      socket.setKeepAlive(true, keepaliveMs);
      socket.setNoDelay(true);
      return socket;
    }) as NonNullable<ClientOptions['createConnection']>;
    let ws: WebSocket;
    try {
      ws = new WebSocket(parsed, {
        headers: { 'User-Agent': AUTOPUSH_USER_AGENT, Origin: 'https://x.com' },
        perMessageDeflate: false, autoPong: false, maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
        // tungstenite has byte caps but no fragment/chunk-count cap. Keep that
        // valid-message boundary instead of inheriting ws 8.22's newer defaults.
        maxFragments: 0, maxBufferedChunks: 0,
        createConnection,
      });
    } catch (cause) { throw new AngelicAngelError('AutoPush', 'WebSocket connect failed', { cause }); }
    this.ws = ws;
    this.signal = signal;
    ws.on('upgrade', (response) => {
      const socket = response.socket;
      socket.prependListener('data', frameSizeGuard(() => {
        this.enqueue({ type: 'error', error: new AngelicAngelError('WebSocket', 'WebSocket frame exceeds the 16 MiB limit') });
        socket.destroy();
      }));
    });
    ws.on('message', (data, binary) => this.enqueue(binary ? { type: 'binary', data: bufferOf(data) } : { type: 'text', data: bufferOf(data).toString('utf8') }));
    ws.on('ping', (data: Buffer) => this.enqueue({ type: 'ping', data }));
    ws.on('pong', (data: Buffer) => this.enqueue({ type: 'pong', data }));
    ws.on('error', (cause: Error) => this.enqueue({ type: 'error', error: new AngelicAngelError('WebSocket', 'WebSocket connection error', { cause }) }));
    ws.on('close', (code, reason) => {
      this.ended = true;
      this.removeAbortHandler();
      if (code === 1006 && !signal?.aborted) {
        this.enqueue({ type: 'error', error: new AngelicAngelError('WebSocket', 'WebSocket closed without a close frame') });
      } else this.enqueue({ type: 'close', code, reason: reason.toString('utf8') });
    });
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { ws.off('open', open); ws.off('error', failed); ws.off('close', closed); };
      const open = (): void => { this.connectionOpened = true; cleanup(); resolve(); };
      const failed = (cause: Error): void => {
        cleanup(); this.removeAbortHandler();
        reject(new AngelicAngelError('AutoPush', 'WebSocket connect failed', { cause }));
      };
      const closed = (): void => { cleanup(); reject(signal?.aborted ? this.aborted() : new AngelicAngelError('AutoPush', 'connection closed by server')); };
      ws.once('open', open); ws.once('error', failed); ws.once('close', closed);
      if (signal) {
        this.abortHandler = () => {
          this.enqueue({ type: 'error', error: this.aborted() });
          cleanup(); ws.terminate(); reject(this.aborted());
        };
        signal.addEventListener('abort', this.abortHandler, { once: true });
        if (signal.aborted) this.abortHandler();
      }
    });
  }
  private async readFrame(timeoutMs?: number): Promise<WsFrame | null | undefined> {
    if (this.signal?.aborted) throw this.aborted();
    if (!this.ws) throw new AngelicAngelError('AutoPush', 'client is not connected');
    if (this.waiter) throw new AngelicAngelError('AutoPush', 'concurrent receives are not supported');
    let frame: QueuedFrame | null | undefined;
    if (this.queue.length) frame = this.queue.shift();
    else if (this.ended) frame = null;
    else frame = await new Promise<QueuedFrame | null | undefined>((resolve) => {
      const waiter: Waiter = { resolve };
      this.waiter = waiter;
      if (timeoutMs !== undefined) waiter.timer = setTimeout(() => {
        if (this.waiter === waiter) this.waiter = undefined;
        resolve(undefined);
      }, Math.max(0, timeoutMs));
      this.ws?.resume();
    });
    if (frame?.type === 'error') throw frame.error;
    return frame;
  }
  async receive(timeoutMs?: number): Promise<WsFrame | null> {
    const frame = await this.readFrame(timeoutMs);
    if (frame === undefined) throw new AngelicAngelError('AutoPush', 'receive timed out');
    return frame;
  }
  private async send(data: string | Buffer, kind: 'text' | 'ping' | 'pong' = 'text'): Promise<void> {
    if (this.signal?.aborted) throw this.aborted();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new AngelicAngelError('WebSocket', 'WebSocket is not open');
    await new Promise<void>((resolve, reject) => {
      const done = (cause?: Error): void => { if (cause) reject(new AngelicAngelError('WebSocket', 'WebSocket send failed', { cause })); else resolve(); };
      if (kind === 'ping') ws.ping(data, true, done);
      else if (kind === 'pong') ws.pong(data, true, done);
      else ws.send(data, { binary: false }, done);
    });
  }
  private async response(operation: 'hello' | 'register'): Promise<AutoPushResponse> {
    const frame = await this.readFrame(this.options.requestTimeoutMs);
    if (frame === undefined) throw new AngelicAngelError('AutoPush', `${operation} response timed out (10s)`);
    if (frame === null) throw new AngelicAngelError('AutoPush', 'connection closed by server');
    if (frame.type !== 'text') throw new AngelicAngelError('AutoPush', 'unexpected message type');
    return parseResponse(frame.data);
  }
  async hello(uaid = '', context: 'new' | 'reconnect' | 'unregister' = 'new'): Promise<HelloResponse> {
    await this.send(serializeMessage({ messageType: 'hello', uaid, use_webpush: true, broadcasts: {} }));
    const response = await this.response('hello');
    const suffix = context === 'new' ? '' : ` (${context})`;
    if (response.messageType !== 'hello') throw new AngelicAngelError('AutoPush', `unexpected response: expected hello${suffix}`);
    if (response.status !== 200) throw new AngelicAngelError('AutoPush', `hello failed${suffix}: status=${response.status}`);
    this.currentUaid = response.uaid;
    return response;
  }
  async register(channelId = randomUUID()): Promise<AutoPushRegistration> {
    await this.send(serializeMessage({ messageType: 'register', channelID: channelId, key: TWITTER_VAPID_PUBLIC_KEY.toString('base64url') }));
    const response = await this.response('register');
    if (response.messageType !== 'register') throw new AngelicAngelError('AutoPush', 'unexpected response: expected register');
    if (response.status !== 200) throw new AngelicAngelError('AutoPush', `register failed: status=${response.status}`);
    // Legacy Rust intentionally uses the locally generated channel ID, not the response's channelID.
    this.currentChannelId = channelId;
    return { uaid: this.currentUaid, channel_id: channelId, endpoint: response.pushEndpoint };
  }
  async unregister(channelId: string): Promise<void> {
    await this.send(serializeMessage({ messageType: 'unregister', channelID: channelId, code: 200 }));
  }
  async ack(channelId: string, version: string, code = AckCode.Delivered): Promise<void> {
    await this.send(serializeMessage({ messageType: 'ack', updates: [{ channelID: channelId, version, code }] }));
  }
  async ackNotification(channelId: string, version: string, code: AckCode): Promise<void> { await this.ack(channelId, version, code); }
  async ack_notification(channelId: string, version: string, code: AckCode): Promise<void> { await this.ack(channelId, version, code); }
  async nextNotification(): Promise<Notification | null> {
    let nextAppPing = performance.now() + this.options.appPingIntervalMs;
    let nextWsPing = performance.now() + this.options.wsPingIntervalMs;
    while (true) {
      const now = performance.now();
      const frame = await this.readFrame(Math.max(0, Math.min(nextAppPing - now, nextWsPing - now)));
      if (frame !== undefined) {
        nextAppPing = performance.now() + this.options.appPingIntervalMs;
        nextWsPing = performance.now() + this.options.wsPingIntervalMs;
        if (frame === null) return null;
        if (frame.type === 'text') {
          if (isPong(frame.data)) continue;
          const response = parseResponse(frame.data);
          if (response.messageType !== 'notification') continue;
          if (this.recentMessageIdsSet.has(response.version)) {
            await this.ack(response.channelID, response.version, AckCode.Delivered);
            continue;
          }
          if (this.recentMessageIds.length >= MAX_RECENT_MESSAGE_IDS) {
            const old = this.recentMessageIds.shift();
            if (old !== undefined) this.recentMessageIdsSet.delete(old);
          }
          this.recentMessageIds.push(response.version);
          this.recentMessageIdsSet.add(response.version);
          return notificationOf(response);
        }
        if (frame.type === 'ping') { await this.send(frame.data, 'pong'); continue; }
        if (frame.type === 'close') {
          if (isBackoffClose(frame.code)) throw new AngelicAngelError('AutoPush', 'BACKOFF: server requested backoff');
          return null;
        }
        continue;
      }
      if (performance.now() >= nextAppPing) {
        await this.send('{}');
        const result = await this.waitForPongOrNotification();
        if (result.kind === 'notification') return result.notification;
        if (result.kind === 'closed') return null;
        if (result.kind === 'timeout') throw new AngelicAngelError('AutoPush', 'pong timed out, reconnection needed');
        nextAppPing = performance.now() + this.options.appPingIntervalMs;
        nextWsPing = performance.now() + this.options.wsPingIntervalMs;
      } else {
        await this.send(Buffer.alloc(0), 'ping');
        nextWsPing = performance.now() + this.options.wsPingIntervalMs;
      }
    }
  }
  private async waitForPongOrNotification(): Promise<PongWaitResult> {
    const deadline = performance.now() + this.options.requestTimeoutMs;
    while (true) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return { kind: 'timeout' };
      const frame = await this.readFrame(remaining);
      if (frame === undefined) return { kind: 'timeout' };
      if (frame === null) return { kind: 'closed' };
      if (frame.type === 'text') {
        if (isPong(frame.data)) return { kind: 'pong' };
        const response = parseResponse(frame.data);
        // Retain the Rust branch's behavior: notifications during a pong wait are not added
        // to the recent-message cache. A later phase may change this with explicit tests.
        if (response.messageType === 'notification') return { kind: 'notification', notification: notificationOf(response) };
      } else if (frame.type === 'ping') await this.send(frame.data, 'pong');
      else if (frame.type === 'close') {
        if (isBackoffClose(frame.code)) throw new AngelicAngelError('AutoPush', 'BACKOFF: server requested backoff');
        return { kind: 'closed' };
      }
    }
  }
  async close(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) { this.removeAbortHandler(); return; }
    if (!this.connectionOpened || ws.readyState === WebSocket.CONNECTING) { ws.terminate(); return; }
    this.closing = true;
    ws.resume();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { ws.terminate(); finish(); }, this.options.requestTimeoutMs);
      const finish = (): void => { clearTimeout(timer); ws.off('close', finish); resolve(); };
      ws.once('close', finish);
      // No close code mirrors Rust close(None), rather than silently substituting 1000.
      ws.close();
    });
    this.removeAbortHandler();
  }
}

export async function registerNew(_keys: WebPushKeys, options: AutoPushOptions = {}): Promise<AutoPushRegistration> {
  const client = new AutoPushClient(options);
  try { await client.connect(); await client.hello(''); return await client.register(); }
  finally { await client.close(); }
}
export async function connectAndListen(session: AutoPushSession, _keys: WebPushKeys, options: AutoPushOptions = {}): Promise<ConnectResult> {
  const client = new AutoPushClient(options);
  try {
    await client.connect();
    const response = await client.hello(session.uaid, 'reconnect');
    if (response.uaid !== session.uaid) {
      await client.close();
      if (!options.allowReregistration) {
        throw new AngelicAngelError('AutoPush', 'UAID invalid; legacy re-registration requires explicit authorization');
      }
      const keys = generateKeys();
      const registration = await registerNew(keys, options);
      return { kind: 'NeedsReregistration', registration, keys };
    }
    client.setSession(session);
    return { kind: 'Connected', client };
  } catch (error) { await client.close(); throw error; }
}
export async function unregister(session: AutoPushSession, options: AutoPushOptions = {}): Promise<void> {
  const client = new AutoPushClient(options);
  try { await client.connect(); await client.hello(session.uaid, 'unregister'); await client.unregister(session.channel_id); }
  finally { await client.close(); }
}
