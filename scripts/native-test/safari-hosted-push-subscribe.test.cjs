'use strict';

// Only for disposable GitHub-hosted macOS runners. The fixture creates its own
// application server key and opens no external website. The optional delivery
// probe sends one synthetic push through Apple's service. The endpoint and
// public/auth keys are held only in fixture memory and are never logged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createECDH, createHash, randomBytes } = require('node:crypto');
const { Resolver, lookup } = require('node:dns/promises');
const syncFs = require('node:fs');
const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const enabled = process.platform === 'darwin' && process.env.CBTE_SAFARI_PUSH_HOSTED === '1';
const axProbePath = path.join(__dirname, 'safari-hosted-ax-probe.swift');

function isFixtureHost(host) {
  return host === 'localhost' || host === '127.0.0.1';
}

function isFixtureScheme(scheme) { return scheme === 'http' || scheme === 'https'; }

function isLoopbackResolution(entries) {
  return Array.isArray(entries) && entries.length > 0 && entries.every(entry =>
    entry?.address === '127.0.0.1' || entry?.address === '::1');
}

function isApprovedAppleIPv4(address) {
  // Apple documents 17/8 for APNs. Refuse other addresses rather than probing
  // a private or unexpected destination if DNS changes or is misconfigured.
  return net.isIP(address) === 4 && address.startsWith('17.');
}

function socketErrorCategory(code) {
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ETIMEDOUT') return 'timeout';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'unreachable';
  return 'error';
}

async function probeApnsHost(host, port) {
  const resolver = new Resolver({ timeout: 2500, tries: 1 });
  const timer = setTimeout(() => resolver.cancel(), 3500);
  let addresses;
  try {
    addresses = await resolver.resolve4(host);
  } catch (error) {
    return { dns: error?.code === 'ETIMEOUT' || error?.code === 'ECANCELLED' ? 'timeout' : 'error', tcp: 'not_attempted' };
  } finally {
    clearTimeout(timer);
  }
  const address = addresses.find(isApprovedAppleIPv4);
  if (!address) return { dns: 'outside_documented_range', tcp: 'not_attempted' };
  return new Promise(resolve => {
    let settled = false;
    const socket = net.createConnection({ host: address, port });
    const finish = tcp => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ dns: 'resolved', tcp });
    };
    socket.setTimeout(3000, () => finish('timeout'));
    socket.once('connect', () => finish('connected'));
    socket.once('error', error => finish(socketErrorCategory(error?.code)));
  });
}

function processPresence(name) {
  const result = spawnSync('/usr/bin/pgrep', ['-x', name], { timeout: 3000, stdio: 'ignore' });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return 'unknown';
}

function parseLaunchctlState(output) {
  // launchctl print is diagnostic output, not a stable machine API. Only a
  // single known state line is accepted; anything else stays unknown.
  const matches = [...output.matchAll(/^[\t ]*state[\t ]*=[\t ]*(running|waiting|not running|exited)[\t ]*$/gm)];
  if (matches.length !== 1) return 'unknown';
  return matches[0][1] === 'running' ? 'running' : 'not_running';
}

function launchdApsdState() {
  const options = { timeout: 4000, encoding: 'utf8', maxBuffer: 262144, stdio: ['ignore', 'pipe', 'ignore'] };
  let result = spawnSync('/bin/launchctl', ['print', 'system/com.apple.apsd'], options);
  if (result.status !== 0) {
    // GitHub-hosted VMs may require privilege for this read-only system query.
    result = spawnSync('/usr/bin/sudo', ['-n', '/bin/launchctl', 'print', 'system/com.apple.apsd'], options);
  }
  if (result.status !== 0 || typeof result.stdout !== 'string') return 'unknown';
  return parseLaunchctlState(result.stdout);
}

function parseApsdDisabledState(output) {
  // launchctl's diagnostic output is not a stable API. Only the exact system
  // service label and one explicit disabled/enabled state are accepted. Absence, unexpected
  // syntax, and duplicate entries do not establish whether the service runs.
  if (typeof output !== 'string' || output.length > 262144) return 'unknown';
  const matches = [...output.matchAll(/^[\t ]*"com\.apple\.apsd"[\t ]*=>[\t ]*(true|false|disabled|enabled)[\t ]*$/gm)];
  return matches.length === 1 ? ['true', 'disabled'].includes(matches[0][1]) : 'unknown';
}

function launchdApsdDisabled() {
  const options = { timeout: 4000, encoding: 'utf8', maxBuffer: 262144, stdio: ['ignore', 'pipe', 'ignore'] };
  let result = spawnSync('/bin/launchctl', ['print-disabled', 'system'], options);
  if (result.status !== 0) {
    // Read-only fallback on the disposable hosted runner; never modify launchd.
    result = spawnSync('/usr/bin/sudo', ['-n', '/bin/launchctl', 'print-disabled', 'system'], options);
  }
  return result.status === 0 ? parseApsdDisabledState(result.stdout) : 'unknown';
}

function parsePsApsdPresence(output) {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const names = lines.map(line => path.posix.basename(line));
  // Require the ps process itself as a sanity check for a usable snapshot.
  if (!names.includes('ps')) return 'unknown';
  return names.includes('apsd');
}

function psApsdPresence() {
  const result = spawnSync('/bin/ps', ['-A', '-o', 'comm='], {
    timeout: 4000, encoding: 'utf8', maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return 'unknown';
  return parsePsApsdPresence(result.stdout);
}

function recordApsdState(stage) {
  try {
    // Raw launchctl/ps output, identifiers, environment and paths stay in memory.
    console.log(`Safari hosted apsd ${stage}: ${JSON.stringify({ launchd: launchdApsdState(), disabled: launchdApsdDisabled(),
      psBasename: psApsdPresence(), pgrepExact: processPresence('apsd') })}`);
  } catch {
    console.log(`Safari hosted apsd ${stage}: unknown`);
  }
}

// Exact, non-parameterized messages from WebKit's public PushService.mm.
// The system query and the in-memory classifier both enforce this allowlist.
const webPushMessages = Object.freeze({
  service_unavailable: 'Push service initialization failed because ApplePushService is unavailable',
  database_error: 'Push service initialization failed with database error',
  known_public_token: 'Received expected public token',
  public_token_changed: 'Public token changed; invalidated all existing push subscriptions',
});
// These public WebKit messages contain variable/sensitive suffixes. Match
// their fixed prefixes in memory and report only aggregate booleans. They
// are not attributed to the fixture unless separately corroborated.
const webPushPrefixes = Object.freeze({
  any_decoded: 'Decoded incoming push message for ',
  any_unknown_topic: 'Dropping incoming push sent to unknown topic: ',
  any_decryption_error: 'Dropping incoming push due to decryption error for topic ',
});

function isSyntheticFixtureScope(value) {
  const match = typeof value === 'string' && /^https?:\/\/(?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4})\/$/.exec(value);
  return Boolean(match && Number(match[1]) <= 65535);
}
function classifyWebPushLogs(output, fixtureScope) {
  let entries;
  try { entries = JSON.parse(output); } catch { return { status: 'unknown' }; }
  if (!Array.isArray(entries) || entries.length > 1000) return { status: 'unknown' };
  const flags = Object.fromEntries([...Object.keys(webPushMessages), ...Object.keys(webPushPrefixes)].map(name => [name, false]));
  let fixtureDecoded = isSyntheticFixtureScope(fixtureScope) ? 'unconfirmed' : 'unavailable';
  for (const entry of entries) {
    const value = entry?.eventMessage;
    const key = Object.keys(webPushMessages).find(name => webPushMessages[name] === value)
      || (typeof value === 'string' && Object.keys(webPushPrefixes).find(name => value.startsWith(webPushPrefixes[name])));
    if (!key) return { status: 'unknown' };
    flags[key] = true;
    // WebKit's decoded message ends with its scope. On privacy-redacted or
    // differently formatted systems, leave the fixture attribution unconfirmed.
    if (key === 'any_decoded' && fixtureDecoded !== 'unavailable' && value.trimEnd().endsWith(` ${fixtureScope}`)) fixtureDecoded = 'observed';
  }
  // False only means no matching recorded event was returned; it does not rule
  // out an issue, because log availability, versions and persistence differ.
  return { status: entries.length ? 'matched' : 'no_matches', ...flags, fixtureDecoded };
}

function utcLogTime(milliseconds) {
  return new Date(milliseconds).toISOString().slice(0, 19).replace('T', ' ') + '+0000';
}

function readWebPushLogs(start, end, predicate, fixtureScope) {
  const args = ['show', '--style', 'json', '--no-pager', '--info', '--start', utcLogTime(start),
    '--end', utcLogTime(end), '--predicate', predicate];
  const options = { timeout: 15000, encoding: 'utf8', maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'ignore'] };
  let result = spawnSync('/usr/bin/log', args, options);
  if (result.status !== 0) result = spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/log', ...args], options);
  return result.status === 0 && typeof result.stdout === 'string'
    ? classifyWebPushLogs(result.stdout, fixtureScope) : { status: 'unknown' };
}
function recordWebPushLogs(startedAt, endedAt, fixtureScope, fixtureSendStartedAt) {
  try {
    // Round inwards so the query never includes time outside the synthetic run.
    const start = Math.ceil(startedAt / 1000) * 1000;
    const end = Math.floor(endedAt / 1000) * 1000;
    if (end <= start || end - start > 15 * 60 * 1000) {
      console.log('Safari hosted WebPush log evidence: unknown');
      return;
    }
    const matches = [...Object.values(webPushMessages).map(message => `eventMessage == "${message}"`),
      ...Object.values(webPushPrefixes).map(prefix => `eventMessage BEGINSWITH "${prefix}"`)].join(' OR ');
    const predicate = `process == "webpushd" AND (${matches})`;
    const classified = readWebPushLogs(start, end, predicate);
    // Attribute a decoded record only when its exact synthetic scope is
    // visible *after this fixture started its single send*. Rounding inward
    // can miss an event, so no match is always merely unconfirmed.
    if (classified.status !== 'unknown' && isSyntheticFixtureScope(fixtureScope)
        && Number.isSafeInteger(fixtureSendStartedAt) && fixtureSendStartedAt >= startedAt && fixtureSendStartedAt < endedAt) {
      const fixtureStart = Math.ceil(fixtureSendStartedAt / 1000) * 1000;
      if (fixtureStart < end) {
        const fixture = readWebPushLogs(fixtureStart, end,
          `process == "webpushd" AND eventMessage BEGINSWITH "${webPushPrefixes.any_decoded}"`, fixtureScope);
        classified.fixtureDecoded = fixture.status === 'unknown' ? 'unknown' : fixture.fixtureDecoded;
      }
    }
    // Never print the original records, process metadata, URLs, IDs or keys.
    console.log(`Safari hosted WebPush log evidence: ${JSON.stringify(classified)}`);
  } catch {
    console.log('Safari hosted WebPush log evidence: unknown');
  }
}

async function recordApnsDiagnostics(stage) {
  try {
    const [provider, courier] = await Promise.all([
      probeApnsHost('api.push.apple.com', 443),
      probeApnsHost('1-courier.push.apple.com', 5223),
    ]);
    // No address, DNS response, process ID, socket data or credentials are logged.
    console.log(`Safari hosted APNs ${stage}: ${JSON.stringify({ providerIPv4: provider, courierIPv4: courier,
      apsd: processPresence('apsd'), webpushd: processPresence('webpushd') })}`);
    recordApsdState(stage);
  } catch {
    console.log(`Safari hosted APNs ${stage}: diagnostic_error`);
  }
}

function classifyAxProbe(probe, mode) {
  if (!['baseline', 'inspect', 'allow'].includes(mode)) return { value: 'unknown', reason: 'invalid_mode' };
  if (probe?.error?.code === 'ETIMEDOUT') return { value: 'unknown', reason: 'timeout' };
  if (probe?.signal) return { value: 'unknown', reason: 'terminated' };
  if (probe?.status !== 0) return { value: 'unknown', reason: 'execution_failed' };
  const output = typeof probe.stdout === 'string' ? probe.stdout.trim() : '';
  if (mode === 'baseline' && output === 'baseline=clean') return { value: 'clean', reason: 'ok' };
  if (mode === 'baseline' && output === 'baseline=not_clean') return { value: 'not_clean', reason: 'ok' };
  if (mode === 'inspect' && output === 'diagnostic=notification_prompt_present') return { value: 'notification_prompt_present', reason: 'ok' };
  if (mode === 'allow' && output === 'diagnostic=allow_pressed') return { value: 'allow_pressed', reason: 'ok' };
  if (mode === 'allow' && output === 'diagnostic=action_uncertain') return { value: 'unknown', reason: 'action_uncertain' };
  if (mode === 'allow' && output === 'diagnostic=unknown') return { value: 'unknown', reason: 'not_identified' };
  return { value: 'unknown', reason: 'unexpected_output' };
}
function validCompiledAxHelper(info, actual, expected, uid, expectedSha, observedSha) {
  return Boolean(info && info.isFile() && !info.isSymbolicLink() && info.uid === uid && info.nlink === 1
    && !(info.mode & 0o022) && (info.mode & 0o100) && info.size >= 1 && info.size <= 10 * 1024 * 1024
    && actual === expected && typeof expectedSha === 'string' && /^[a-f0-9]{64}$/.test(expectedSha)
    && observedSha === expectedSha);
}
function sameAxIdentity(left, right) {
  return Boolean(left && right && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(name => left[name] === right[name]));
}
function inspectCompiledAxHelper(filename, expected, expectedSha, uid) {
  const info = syncFs.lstatSync(filename), actual = syncFs.realpathSync(filename);
  let fd, bytes;
  try {
    if (!syncFs.constants.O_NOFOLLOW || !validCompiledAxHelper(info, actual, expected, uid, expectedSha, expectedSha)) throw new Error();
    fd = syncFs.openSync(filename, syncFs.constants.O_RDONLY | syncFs.constants.O_NOFOLLOW);
    const opened = syncFs.fstatSync(fd);
    if (!sameAxIdentity(info, opened) || !opened.isFile() || opened.size < 1 || opened.size > 10 * 1024 * 1024) throw new Error();
    bytes = Buffer.alloc(opened.size); let offset = 0;
    while (offset < bytes.length) {
      const count = syncFs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error();
      offset += count;
    }
    const digest = createHash('sha256').update(bytes).digest('hex'), after = syncFs.fstatSync(fd);
    if (!sameAxIdentity(opened, after) || bytes.length !== opened.size
        || !validCompiledAxHelper(info, actual, expected, uid, expectedSha, digest)) throw new Error();
    const final = syncFs.lstatSync(filename);
    if (!sameAxIdentity(info, final) || syncFs.realpathSync(filename) !== expected) throw new Error();
    return info;
  } finally { bytes?.fill(0); if (fd !== undefined) syncFs.closeSync(fd); }
}
function axProbeDetails(mode) {
  let executable = '/usr/bin/swift', args = [axProbePath, mode], helperIdentity;
  if (process.env.CBTE_SAFARI_AX_HELPER) {
    try {
      if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true'
          || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || typeof process.getuid !== 'function'
          || typeof process.env.RUNNER_TEMP !== 'string' || !path.isAbsolute(process.env.RUNNER_TEMP)) throw new Error();
      const directory = syncFs.realpathSync(process.env.RUNNER_TEMP);
      const expected = path.join(directory, 'cbte-safari-ax');
      const supplied = process.env.CBTE_SAFARI_AX_HELPER;
      helperIdentity = inspectCompiledAxHelper(supplied, expected, process.env.CBTE_SAFARI_AX_SHA256, process.getuid());
      executable = expected; args = [mode];
    } catch { return { value: 'unknown', reason: 'helper_invalid' }; }
  }
  const probe = spawnSync(executable, args, {
    // Fresh hosted VMs may need to initialise Swift compiler caches first.
    encoding: 'utf8', timeout: 45000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (helperIdentity) {
    try {
      const current = inspectCompiledAxHelper(executable, executable, process.env.CBTE_SAFARI_AX_SHA256, process.getuid());
      if (!sameAxIdentity(helperIdentity, current)) throw new Error();
    } catch { return { value: 'unknown', reason: 'helper_changed' }; }
  }
  return classifyAxProbe(probe, mode);
}
function axProbe(mode) {
  const result = axProbeDetails(mode);
  if (result.value === 'unknown') console.log(`Safari synthetic AX inspection: ${result.reason}`);
  return result.value;
}

async function waitForFixturePrompt(probe, wait, attempts) {
  if (typeof probe !== 'function' || typeof wait !== 'function' || !Number.isInteger(attempts) || attempts < 1 || attempts > 12)
    throw new Error('FIXTURE_SAFARI_AX_CONFIG_INVALID');
  for (let i = 0; i < attempts; i++) {
    const result = probe('allow');
    if (result?.value === 'allow_pressed') return { value: 'allow_pressed', reason: 'ok', attempts: i + 1 };
    // Unidentified is the only safe retry: helper, hash, process, and other
    // failures stop immediately. Each helper call rechecks the full UI identity.
    if (result?.value !== 'unknown' || result.reason !== 'not_identified') return { value: 'unknown', reason: 'probe_failed', attempts: i + 1 };
    if (i + 1 < attempts) await wait(500);
  }
  return { value: 'unknown', reason: 'not_identified', attempts };
}

function inspectClickFailure(error, inspect) {
  if (error?.message !== 'Safari synthetic button click: timeout') return 'not_attempted';
  try {
    // Read-only: never press a control while the WebDriver command is pending.
    return inspect('inspect') === 'notification_prompt_present' ? 'notification_prompt_present' : 'unknown';
  } catch { return 'unknown'; }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function listenIPv6Loopback(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '::1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function command(port, method, path, body, stage, timeoutMs = 15000) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json();
    if (response.status !== 200) {
      // Only fixed, non-sensitive WebDriver error categories are exposed.
      const code = ['unexpected alert open', 'no such alert', 'script timeout'].includes(data.value?.error)
        ? data.value.error : 'other WebDriver error';
      throw new Error(`Safari ${stage}: HTTP ${response.status}, ${code}`);
    }
    return data.value;
  } catch (error) {
    if (typeof error?.message === 'string' && error.message.startsWith(`Safari ${stage}:`)) throw error;
    throw new Error(`Safari ${stage}: ${error?.name === 'TimeoutError' ? 'timeout' : 'transport or invalid response'}`);
  }
}

function outcome(state, permission) {
  if (state === 'subscribed') return 'subscribed';
  if (state === 'denied' || permission === 'denied') return 'denied';
  if (state === 'error') return 'subscription_error';
  if (state !== 'pending') return 'unexpected_state';
  if (permission === 'default') return 'permission_pending_timeout';
  if (permission === 'granted') return 'subscription_timeout_after_permission_granted';
  return 'subscription_timeout_permission_unknown';
}

function fixturePushStatus(value) {
  const names = ['control', 'event', 'showResolved', 'showRejected', 'fetchFailed'];
  if (!value || typeof value !== 'object' || names.some(name => typeof value[name] !== 'boolean'))
    throw new Error('FIXTURE_SAFARI_PUSH_STATUS_INVALID');
  return Object.fromEntries(names.map(name => [name, value[name]]));
}

test('subscription result categories do not turn pending or refusal into success', () => {
  assert.equal(outcome('subscribed', 'granted'), 'subscribed');
  assert.equal(outcome('denied', 'default'), 'denied');
  assert.equal(outcome('pending', 'denied'), 'denied');
  assert.equal(outcome('pending', 'default'), 'permission_pending_timeout');
  assert.equal(outcome('pending', 'granted'), 'subscription_timeout_after_permission_granted');
  assert.equal(outcome('error', 'default'), 'subscription_error');
});

test('synthetic push status reports only fixed boolean stages', () => {
  assert.deepEqual(fixturePushStatus({ control: true, event: true, showResolved: false, showRejected: false, fetchFailed: true, private: 'not-logged' }),
    { control: true, event: true, showResolved: false, showRejected: false, fetchFailed: true });
  assert.throws(() => fixturePushStatus({ event: true }), /FIXTURE_SAFARI_PUSH_STATUS_INVALID/);
});

test('AX helper classifies failures without exposing raw output', () => {
  assert.deepEqual(classifyAxProbe({ status: 0, stdout: 'baseline=clean\n' }, 'baseline'), { value: 'clean', reason: 'ok' });
  assert.deepEqual(classifyAxProbe({ status: 0, stdout: 'baseline=not_clean\n' }, 'baseline'), { value: 'not_clean', reason: 'ok' });
  assert.deepEqual(classifyAxProbe({ status: null, error: { code: 'ETIMEDOUT', message: 'private path' } }, 'baseline'), { value: 'unknown', reason: 'timeout' });
  assert.deepEqual(classifyAxProbe({ status: null, signal: 'SIGTERM' }, 'allow'), { value: 'unknown', reason: 'terminated' });
  assert.deepEqual(classifyAxProbe({ status: 1, stderr: 'private' }, 'allow'), { value: 'unknown', reason: 'execution_failed' });
  assert.deepEqual(classifyAxProbe({ status: 0, stdout: 'private' }, 'baseline'), { value: 'unknown', reason: 'unexpected_output' });
  assert.deepEqual(classifyAxProbe({ status: 0, stdout: 'diagnostic=unknown' }, 'allow'), { value: 'unknown', reason: 'not_identified' });
  assert.deepEqual(classifyAxProbe({ status: 0, stdout: 'diagnostic=action_uncertain' }, 'allow'), { value: 'unknown', reason: 'action_uncertain' });
});

test('fixture prompt retries only an unidentified UI and never presses twice', async () => {
  let calls = 0, waits = 0;
  const result = await waitForFixturePrompt(mode => { assert.equal(mode, 'allow'); calls++;
    return calls === 3 ? { value: 'allow_pressed', reason: 'ok' } : { value: 'unknown', reason: 'not_identified' };
  }, async () => { waits++; }, 5);
  assert.deepEqual(result, { value: 'allow_pressed', reason: 'ok', attempts: 3 }); assert.equal(calls, 3); assert.equal(waits, 2);
  for (const reason of ['helper_invalid', 'helper_changed', 'timeout', 'execution_failed', 'action_uncertain']) {
    calls = 0;
    const failed = await waitForFixturePrompt(() => { calls++; return { value: 'unknown', reason }; }, async () => { assert.fail('must not retry'); }, 5);
    assert.equal(failed.value, 'unknown'); assert.equal(calls, 1);
  }
  assert.deepEqual(await waitForFixturePrompt(() => ({ value: 'unknown', reason: 'not_identified' }), async () => {}, 2),
    { value: 'unknown', reason: 'not_identified', attempts: 2 });
});

test('compiled AX helper requires an owned bounded fixed executable', () => {
  const info = { isFile: () => true, isSymbolicLink: () => false, uid: 501, nlink: 1, mode: 0o700, size: 1024 };
  const hash = 'a'.repeat(64);
  assert.equal(validCompiledAxHelper(info, '/tmp/cbte-safari-ax', '/tmp/cbte-safari-ax', 501, hash, hash), true);
  for (const invalid of [{ ...info, uid: 502 }, { ...info, nlink: 2 }, { ...info, mode: 0o722 },
    { ...info, mode: 0o600 }, { ...info, size: 0 }, { ...info, size: 10 * 1024 * 1024 + 1 },
    { ...info, isSymbolicLink: () => true }, { ...info, isFile: () => false }])
    assert.equal(validCompiledAxHelper(invalid, '/tmp/cbte-safari-ax', '/tmp/cbte-safari-ax', 501, hash, hash), false);
  assert.equal(validCompiledAxHelper(info, '/tmp/other', '/tmp/cbte-safari-ax', 501, hash, hash), false);
  assert.equal(validCompiledAxHelper(info, '/tmp/cbte-safari-ax', '/tmp/cbte-safari-ax', 501, hash, 'b'.repeat(64)), false);
  assert.equal(validCompiledAxHelper(info, '/tmp/cbte-safari-ax', '/tmp/cbte-safari-ax', 501, '', hash), false);
  const identity = { dev: 1, ino: 2, size: 1024, mtimeMs: 3, ctimeMs: 4 };
  assert.equal(sameAxIdentity(identity, { ...identity }), true);
  for (const name of Object.keys(identity)) assert.equal(sameAxIdentity(identity, { ...identity, [name]: identity[name] + 1 }), false);
});

test('compiled AX helper verifies actual bytes before and after tampering', { skip: process.platform !== 'darwin' || typeof process.getuid !== 'function' }, () => {
  // Only a newly created temp file is used; no installed application or user
  // data is read, and no recursive deletion is performed.
  const temp = syncFs.realpathSync(os.tmpdir()), directory = syncFs.mkdtempSync(path.join(temp, 'cbte-safari-ax-test-'));
  const filename = path.join(directory, 'cbte-safari-ax');
  try {
    syncFs.writeFileSync(filename, 'synthetic helper', { flag: 'wx', mode: 0o700 });
    const digest = createHash('sha256').update('synthetic helper').digest('hex');
    const first = inspectCompiledAxHelper(filename, filename, digest, process.getuid());
    assert.equal(sameAxIdentity(first, inspectCompiledAxHelper(filename, filename, digest, process.getuid())), true);
    syncFs.writeFileSync(filename, 'tampered helper');
    assert.throws(() => inspectCompiledAxHelper(filename, filename, digest, process.getuid()));
  } finally {
    try { syncFs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    syncFs.rmdirSync(directory);
  }
});

test('click-timeout diagnostic only inspects and never converts a failure to success', () => {
  const modes = [];
  assert.equal(inspectClickFailure(new Error('Safari synthetic button click: timeout'), mode => { modes.push(mode); return 'notification_prompt_present'; }), 'notification_prompt_present');
  assert.deepEqual(modes, ['inspect']);
  assert.equal(inspectClickFailure(new Error('Safari synthetic button click: timeout'), () => { throw new Error('private'); }), 'unknown');
  assert.equal(inspectClickFailure(new Error('other failure'), () => { throw new Error('must not run'); }), 'not_attempted');
});

test('fixture host and localhost DNS are restricted to the expected loopback addresses', () => {
  assert.equal(isFixtureHost('localhost'), true);
  assert.equal(isFixtureHost('127.0.0.1'), true);
  assert.equal(isFixtureHost('localhost.example'), false);
  assert.equal(isFixtureScheme('http'), true);
  assert.equal(isFixtureScheme('https'), true);
  assert.equal(isFixtureScheme('file'), false);
  assert.equal(isLoopbackResolution([{ address: '127.0.0.1' }, { address: '::1' }]), true);
  assert.equal(isLoopbackResolution([{ address: '127.0.0.1' }, { address: '192.0.2.1' }]), false);
  assert.equal(isLoopbackResolution([]), false);
});

test('APNs diagnostics restrict addresses and classify socket errors', () => {
  assert.equal(isApprovedAppleIPv4('17.1.2.3'), true);
  assert.equal(isApprovedAppleIPv4('127.0.0.1'), false);
  assert.equal(isApprovedAppleIPv4('17.999.0.1'), false);
  assert.equal(isApprovedAppleIPv4('::1'), false);
  assert.equal(socketErrorCategory('ECONNREFUSED'), 'refused');
  assert.equal(socketErrorCategory('ETIMEDOUT'), 'timeout');
  assert.equal(socketErrorCategory('EHOSTUNREACH'), 'unreachable');
  assert.equal(socketErrorCategory('anything else'), 'error');
});

test('apsd diagnostics reject ambiguous service output and match exact process basename', () => {
  assert.equal(parseLaunchctlState('service = {\n\tstate = running\n}\n'), 'running');
  assert.equal(parseLaunchctlState('service = {\n\tstate = waiting\n}\n'), 'not_running');
  assert.equal(parseLaunchctlState('state = running\nstate = waiting\n'), 'unknown');
  assert.equal(parseLaunchctlState('job state = running\n'), 'unknown');
  assert.equal(parseLaunchctlState('state = changed-format\n'), 'unknown');
  assert.equal(parsePsApsdPresence('/bin/ps\n/usr/libexec/apsd\n'), true);
  assert.equal(parsePsApsdPresence('/bin/ps\n/usr/libexec/notapsd\n'), false);
  assert.equal(parsePsApsdPresence('unrecognized format'), 'unknown');
  assert.equal(parsePsApsdPresence(''), 'unknown');
  assert.equal(parseApsdDisabledState('disabled services = {\n\t"com.apple.apsd" => true\n}\n'), true);
  assert.equal(parseApsdDisabledState('disabled services = {\n\t"com.apple.apsd" => false\n}\n'), false);
  assert.equal(parseApsdDisabledState('disabled services = {\n\t"com.apple.apsd" => disabled\n}\n'), true);
  assert.equal(parseApsdDisabledState('disabled services = {\n\t"com.apple.apsd" => enabled\n}\n'), false);
  assert.equal(parseApsdDisabledState('disabled services = {}'), 'unknown');
  assert.equal(parseApsdDisabledState('"com.apple.apsd" => true\n"com.apple.apsd" => false'), 'unknown');
  assert.equal(parseApsdDisabledState('"com.apple.apsd.other" => true'), 'unknown');
  assert.equal(parseApsdDisabledState('"com.apple.apsd" => yes'), 'unknown');
  assert.equal(parseApsdDisabledState('x'.repeat(262145)), 'unknown');
});

test('hosted macOS records apsd state without changing it', { skip: !enabled, timeout: 30000 }, () => {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions is required');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'A disposable GitHub-hosted runner is required');
  recordApsdState('standalone');
});

test('WebPush logs classify only known messages and reject malformed output', () => {
  assert.deepEqual(classifyWebPushLogs('[]'), { status: 'no_matches', service_unavailable: false,
    database_error: false, known_public_token: false, public_token_changed: false,
    any_decoded: false, any_unknown_topic: false, any_decryption_error: false, fixtureDecoded: 'unavailable' });
  const result = classifyWebPushLogs(JSON.stringify([{ eventMessage: webPushMessages.database_error,
    unrelatedSensitiveField: 'must not appear' }]));
  assert.equal(result.status, 'matched');
  assert.equal(result.database_error, true);
  assert.equal(JSON.stringify(result).includes('must not appear'), false);
  const decoded = classifyWebPushLogs(JSON.stringify([{ eventMessage: `${webPushPrefixes.any_decoded}private-scope` }]));
  assert.equal(decoded.any_decoded, true); assert.equal(JSON.stringify(decoded).includes('private-scope'), false);
  const syntheticScope = 'https://127.0.0.1:4321/';
  const ours = classifyWebPushLogs(JSON.stringify([{ eventMessage: `${webPushPrefixes.any_decoded}com.apple.Safari ${syntheticScope}` }]), syntheticScope);
  assert.equal(ours.fixtureDecoded, 'observed'); assert(!JSON.stringify(ours).includes(syntheticScope));
  assert.equal(classifyWebPushLogs(JSON.stringify([{ eventMessage: `${webPushPrefixes.any_decoded}com.apple.Safari https://other.invalid/${syntheticScope}` }]), syntheticScope).fixtureDecoded, 'unconfirmed');
  assert.equal(classifyWebPushLogs(JSON.stringify([{ eventMessage: `${webPushPrefixes.any_decoded}com.apple.Safari <private>` }]), syntheticScope).fixtureDecoded, 'unconfirmed');
  assert.equal(classifyWebPushLogs('[]', 'https://x.com/').fixtureDecoded, 'unavailable');
  const dropped = classifyWebPushLogs(JSON.stringify([{ eventMessage: `${webPushPrefixes.any_decryption_error}private-topic` }]));
  assert.equal(dropped.any_decryption_error, true); assert.equal(JSON.stringify(dropped).includes('private-topic'), false);
  const unknown = classifyWebPushLogs(JSON.stringify([{ eventMessage: `${webPushPrefixes.any_unknown_topic}private-topic` }]));
  assert.equal(unknown.any_unknown_topic, true); assert.equal(JSON.stringify(unknown).includes('private-topic'), false);
  assert.deepEqual(classifyWebPushLogs('[{"eventMessage":"unexpected"}]'), { status: 'unknown' });
  assert.deepEqual(classifyWebPushLogs('invalid'), { status: 'unknown' });
});

test('hosted macOS checks UI inspection permissions without requesting them', { skip: !enabled, timeout: 90000 }, () => {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions is required');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'A disposable GitHub-hosted runner is required');
  // Both APIs only report the current authorization state. No capture, prompt,
  // accessibility action, or settings change is requested by this probe.
  const script = 'import ApplicationServices\nimport CoreGraphics\nprint("AX_TRUSTED=\\(AXIsProcessTrusted())")\nprint("SCREEN_CAPTURE_TRUSTED=\\(CGPreflightScreenCaptureAccess())")';
  const probe = spawnSync('/usr/bin/swift', ['-e', script], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(probe.status, 0, 'Could not check hosted macOS UI inspection permissions');
  const match = /^AX_TRUSTED=(true|false)\r?\nSCREEN_CAPTURE_TRUSTED=(true|false)\r?\n?$/.exec(probe.stdout || '');
  assert.ok(match, 'Permission probe returned an unexpected response');
  console.log(`Safari hosted UI preflight: accessibility=${match[1]} screenCapture=${match[2]}`);
});

test('hosted Safari attempts a synthetic push subscription', { skip: !enabled, timeout: 360000 }, async () => {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions is required');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'A disposable GitHub-hosted runner is required');
  const fixtureHost = process.env.CBTE_SAFARI_FIXTURE_HOST;
  const fixtureScheme = process.env.CBTE_SAFARI_FIXTURE_SCHEME;
  assert.equal(isFixtureHost(fixtureHost), true, 'A fixed loopback fixture host is required');
  assert.equal(isFixtureScheme(fixtureScheme), true, 'A fixed fixture scheme is required');
  assert.ok(fixtureScheme !== 'https' || fixtureHost === '127.0.0.1', 'HTTPS is limited to the verified loopback fixture');
  console.log(`Safari synthetic origin case: ${fixtureScheme} ${fixtureHost === 'localhost' ? 'localhost' : 'ipv4_loopback'}`);
  // Never open localhost if the runner resolves it to a non-loopback address.
  if (fixtureHost === 'localhost') {
    const resolution = await Promise.race([
      lookup('localhost', { all: true }),
      delay(3000).then(() => { throw new Error('Localhost lookup timeout'); }),
    ]);
    assert.equal(isLoopbackResolution(resolution), true, 'Localhost did not resolve exclusively to loopback');
  }
  const key = createECDH('prime256v1');
  const publicKey = [...key.generateKeys()];
  const pushMarker = `fixture-${randomBytes(16).toString('hex')}`; let pushDelivered = false;
  // Do not inspect a Safari process that predates this synthetic session.
  const baseline = axProbe('baseline');
  console.log(`Safari synthetic AX baseline: ${baseline}`);
  assert.equal(baseline, 'clean', 'Could not confirm that no Safari was running on the hosted runner');
  await recordApnsDiagnostics('before');
  const syntheticRunStartedAt = Date.now();
  let driver, driverPort, session, page, pageIPv6, certBase, certTemp, fixtureScope, fixtureSendStartedAt, listening = false, listeningIPv6 = false, attempted = false, clean = false;
  const handler = (req, res) => {
    if (req.method === 'GET' && req.url === '/sw.js') {
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
      // Start showNotification immediately, then report its completion and
      // the Push event independently to same-origin fixture clients.
      res.end(`const notifyFixture = async (stage, value) => {
        const clients = await self.clients.matchAll({type:'window', includeUncontrolled:true});
        for (const client of clients) client.postMessage({fixtureMarker:value, stage}); };
      self.addEventListener('message', e => {
        if (e.data?.kind === 'fixture-ping') e.waitUntil(notifyFixture('control', e.data.marker));
      });
      self.addEventListener('push', e => e.waitUntil((async () => {
        const value = e.data ? e.data.text() : '';
        let showing; try { showing = self.registration.showNotification('Synthetic fixture').then(() => true, () => false); }
        catch { showing = Promise.resolve(false); }
        await notifyFixture('event', value);
        const shown = await showing; await notifyFixture(shown ? 'showResolved' : 'showRejected', value);
        if (!shown) return;
        try { await fetch('/fixture-received?tag=' + encodeURIComponent(value)); }
        catch { await notifyFixture('fetchFailed', value); }
      })()));`);
    } else if (req.method === 'GET' && req.url === `/fixture-received?tag=${pushMarker}`) {
      pushDelivered = true; res.writeHead(200, { 'cache-control': 'no-store' }).end('ok');
    } else if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><title>Push subscription fixture</title>
        <button id="subscribe" disabled>Subscribe</button><script>
        let registration, subscription, cancelled = false;
        let state = 'loading', trustedClick = false, activationAvailable = false, activationActive = false;
        const pushStages = {control:false, event:false, showResolved:false, showRejected:false, fetchFailed:false};
        window.fixturePushStatus = () => ({...pushStages});
        window.fixturePingWorker = () => navigator.serviceWorker.ready.then(r => r.active.postMessage({kind:'fixture-ping', marker:${JSON.stringify(pushMarker)}}));
        navigator.serviceWorker.addEventListener('message', event => {
          if (event.data?.fixtureMarker !== ${JSON.stringify(pushMarker)}) return;
          if (Object.hasOwn(pushStages, event.data.stage)) pushStages[event.data.stage] = true;
        });
        window.fixtureStatus = () => ({state, permission: typeof Notification === 'undefined' ? 'unknown' : Notification.permission,
          trustedClick, activationAvailable, activationActive});
        window.fixtureSubscription = () => state === 'subscribed' && subscription ? subscription.toJSON() : null;
        navigator.serviceWorker.register('/sw.js', {scope:'/'}).then(async r => {
          registration = r; await navigator.serviceWorker.ready;
          state = 'ready'; document.querySelector('#subscribe').disabled = false;
        }).catch(() => { state = 'error'; });
        document.querySelector('#subscribe').addEventListener('click', event => {
          trustedClick = event.isTrusted === true;
          activationAvailable = !!navigator.userActivation;
          activationActive = navigator.userActivation?.isActive === true;
          if (state !== 'ready') { state = 'error'; return; }
          state = 'pending';
          try {
            registration.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:new Uint8Array(${JSON.stringify(publicKey)})})
              .then(async result => {
                subscription = result;
                if (cancelled) { await result.unsubscribe(); state = 'cancelled'; }
                else state = 'subscribed';
              }, error => { state = error && error.name === 'NotAllowedError' ? 'denied' : 'error'; });
          } catch (error) { state = error && error.name === 'NotAllowedError' ? 'denied' : 'error'; }
        });
        window.fixtureCleanup = async () => {
          cancelled = true;
          const current = subscription || (registration && await registration.pushManager.getSubscription());
          const removed = !current || await current.unsubscribe();
          const gone = !registration || !(await registration.pushManager.getSubscription());
          const workerRemoved = !registration || await registration.unregister();
          return {hadSubscription: !!current, removed, gone, workerRemoved};
        };
        </script>`);
    } else res.writeHead(404).end();
  };
  const exec = async (script, stage, timeout = 15000) => command(driverPort, 'POST', `/session/${session}/execute/sync`, { script, args: [] }, stage, timeout);
  const cleanup = async (requireSubscription = false) => {
    const result = await command(driverPort, 'POST', `/session/${session}/execute/async`, {
      script: 'const done=arguments[arguments.length-1]; window.fixtureCleanup().then(done,()=>done({removed:false,workerRemoved:false}));', args: [],
    }, 'fixture cleanup', 20000);
    assert.equal(result?.removed, true, 'Synthetic subscription could not be removed');
    assert.equal(result?.gone, true, 'Synthetic subscription still exists after removal');
    assert.equal(result?.workerRemoved, true, 'Synthetic worker could not be unregistered');
    if (requireSubscription) assert.equal(result?.hadSubscription, true, 'No synthetic subscription was available to remove');
  };
  try {
    if (fixtureScheme === 'https') {
      // Only a throwaway local certificate is generated. The OS trust store is
      // never changed; Safari's insecure-cert setting belongs to this session.
      certTemp = await fs.realpath(os.tmpdir());
      certBase = await fs.mkdtemp(path.join(certTemp, 'cbte-safari-subscribe-https-'));
      assert.equal(path.dirname(await fs.realpath(certBase)), certTemp);
      await fs.chmod(certBase, 0o700);
      const generated = spawnSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=127.0.0.1', '-keyout', path.join(certBase, 'key.pem'), '-out', path.join(certBase, 'cert.pem')],
        { stdio: 'ignore', timeout: 30000 });
      assert.equal(generated.status, 0, 'Could not generate the isolated fixture certificate');
      const privateKey = await fs.readFile(path.join(certBase, 'key.pem'));
      const certificate = await fs.readFile(path.join(certBase, 'cert.pem'));
      try {
        page = https.createServer({ key: privateKey, cert: certificate }, handler);
        pageIPv6 = https.createServer({ key: privateKey, cert: certificate }, handler);
      } finally { privateKey.fill(0); certificate.fill(0); }
    } else {
      page = http.createServer(handler);
      pageIPv6 = http.createServer(handler);
    }
    const pagePort = await listen(page); listening = true;
    fixtureScope = `${fixtureScheme}://${fixtureHost}:${pagePort}/`;
    await listenIPv6Loopback(pageIPv6, pagePort); listeningIPv6 = true;
    if (fixtureScheme === 'https') {
      // Confirm that a normal TLS client rejects the fixture certificate.
      const rejected = await new Promise(resolve => {
        const request = https.get({ host: '127.0.0.1', port: pagePort, rejectUnauthorized: true, timeout: 5000 }, response => {
          response.resume(); resolve(false);
        });
        request.once('timeout', () => { request.destroy(); resolve(false); });
        request.once('error', error => resolve(error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || error.code === 'SELF_SIGNED_CERT_IN_CHAIN'));
      });
      assert.equal(rejected, true, 'The control client did not reject the fixture certificate');
    }
    const reservation = net.createServer(); driverPort = await listen(reservation); await close(reservation);
    driver = spawn('/usr/bin/safaridriver', ['-p', String(driverPort)], { stdio: 'ignore' });
    let spawnError; driver.on('error', error => { spawnError = error; });
    const deadline = Date.now() + 20000; let ready = false;
    console.log('Safari subscription fixture: waiting for driver');
    while (Date.now() < deadline && !ready && !spawnError && driver.exitCode === null && driver.signalCode === null) {
      try { ready = (await command(driverPort, 'GET', '/status', undefined, 'driver readiness', 2000))?.ready === true; } catch { /* still starting */ }
      if (!ready) await delay(250);
    }
    assert.ok(ready, 'Safari WebDriver did not become ready');
    console.log('Safari subscription fixture: creating session');
    const created = await command(driverPort, 'POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari',
      ...(fixtureScheme === 'https' ? { acceptInsecureCerts: true } : {}) } } }, 'session creation', 90000);
    assert.match(created?.sessionId || '', /^[A-Za-z0-9-]{1,128}$/, 'Invalid WebDriver session ID');
    session = created.sessionId;
    assert.equal(created.capabilities?.browserName?.toLowerCase(), 'safari', 'Unexpected browser');
    if (fixtureScheme === 'https') assert.equal(created.capabilities?.acceptInsecureCerts, true, 'Safari did not accept the session-only HTTPS capability');
    await command(driverPort, 'POST', `/session/${session}/url`, { url: `${fixtureScheme}://${fixtureHost}:${pagePort}/` }, 'fixture navigation', 30000);
    const originMatches = await exec(`return location.origin === ${JSON.stringify(`${fixtureScheme}://${fixtureHost}:${pagePort}`)};`, 'fixture origin');
    assert.equal(originMatches, true, 'Browser did not reach the selected synthetic origin');
    console.log('Safari subscription fixture: preparing worker');
    let status;
    const preparationDeadline = Date.now() + 30000;
    do {
      status = await exec('return window.fixtureStatus();', 'fixture preparation');
      if (status?.state !== 'loading') break;
      await delay(250);
    } while (Date.now() < preparationDeadline);
    assert.equal(status?.state, 'ready', 'Synthetic worker did not become ready');
    const element = await command(driverPort, 'POST', `/session/${session}/element`, { using: 'css selector', value: '#subscribe' }, 'find synthetic button');
    const elementId = element?.['element-6066-11e4-a52e-4f735466cecf'];
    assert.match(elementId || '', /^[A-Za-z0-9-]{1,128}$/, 'Invalid synthetic button reference');
    console.log('Safari subscription fixture: clicking synthetic button');
    attempted = true;
    try { await command(driverPort, 'POST', `/session/${session}/element/${elementId}/click`, {}, 'synthetic button click', 30000); }
    catch (error) {
      const diagnostic = inspectClickFailure(error, axProbe);
      if (diagnostic !== 'not_attempted') console.log(`Safari synthetic click timeout UI: ${diagnostic}`);
      throw error;
    }
    const subscriptionDeadline = Date.now() + 90000;
    let clickDiagnosticsReported = false;
    let axDiagnosticsReported = false;
    do {
      status = await exec('return window.fixtureStatus();', 'subscription status');
      if (!clickDiagnosticsReported && typeof status?.trustedClick === 'boolean' &&
          typeof status.activationAvailable === 'boolean' && typeof status.activationActive === 'boolean') {
        console.log(`Safari synthetic click: trusted=${status.trustedClick} activationAvailable=${status.activationAvailable} activationActive=${status.activationActive}`);
        clickDiagnosticsReported = true;
      }
      if (!axDiagnosticsReported && status?.state === 'pending') {
        // The helper repeats every isolation and UI identity check immediately
        // before pressing the unique synthetic prompt's Allow button.
        assert.equal(status.permission, 'default', 'Unexpected synthetic notification permission state');
        assert.equal(status.trustedClick, true, 'Synthetic click was not trusted');
        assert.equal(status.activationAvailable, true, 'User activation API was unavailable');
        assert.equal(status.activationActive, true, 'Synthetic click had no user activation');
        const result = await waitForFixturePrompt(axProbeDetails, delay, process.env.CBTE_SAFARI_AX_HELPER ? 12 : 1);
        console.log(`Safari synthetic notification UI: ${result.value} reason=${result.reason} attempts=${result.attempts}`);
        axDiagnosticsReported = true;
        assert.equal(result.value, 'allow_pressed', 'Synthetic notification permission control was not uniquely verified');
        recordApsdState('after_allow');
      }
      if (status?.state !== 'pending') break;
      await delay(500);
    } while (Date.now() < subscriptionDeadline);
    const result = outcome(status?.state, status?.permission);
    console.log(`Safari subscription fixture outcome: ${result}`);
    assert.equal(axDiagnosticsReported, true, 'Synthetic notification permission control was not inspected');
    assert.equal(status?.permission, 'granted', 'Synthetic notification permission was not granted');
    console.log('Safari subscription fixture: notification permission granted');
    // A default permission state is evidence only of a pending decision, not that
    // a dialog appeared. Failure and timeout must never count as a subscription.
    assert.equal(result, 'subscribed', `Synthetic push subscription did not succeed: ${result}`);
    console.log('Safari subscription fixture: subscription confirmed');
    let captured;
    if (process.env.CBTE_SAFARI_SYNTHETIC_DB_PROBE === '1' || process.env.CBTE_SAFARI_SYNTHETIC_PUSH_PROBE === '1'
        || process.env.CBTE_SAFARI_SYNTHETIC_GET_PROBE === '1')
      captured = await exec('return window.fixtureSubscription();', 'synthetic subscription inspection');
    if (process.env.CBTE_SAFARI_SYNTHETIC_DB_PROBE === '1') {
      // Use only the newly-created synthetic subscription. WebDriver carries
      // the endpoint and public/auth keys in memory; they are never logged.
      const { capturedFixture, inspectHostedSafariDatabase } = require('./safari-synthetic-db-probe.cjs');
      const expected = capturedFixture(captured, Buffer.from(publicKey));
      try {
        const comparison = inspectHostedSafariDatabase(`${fixtureScheme}://${fixtureHost}:${pagePort}/`, expected);
        console.log(`Safari synthetic subscription DB: ${JSON.stringify(comparison)}`);
        if (!comparison.ownerSafari || !comparison.endpointMatches || !comparison.publicKeyMatches
            || !comparison.authMatches || !comparison.vapidMatches)
          throw new Error('FIXTURE_SAFARI_DB_COMPARISON_FAILED');
      } finally { expected.publicKey.fill(0); expected.auth.fill(0); expected.vapid.fill(0); }
    }
    if (process.env.CBTE_SAFARI_SYNTHETIC_GET_PROBE === '1') {
      const { probeHostedSyntheticEndpoint } = require('./safari-synthetic-endpoint-get-probe.cjs');
      const vapidPublic = Buffer.from(publicKey), vapidPrivate = key.getPrivateKey();
      try {
        const evidence = await probeHostedSyntheticEndpoint({ subscription: captured, publicKey: vapidPublic, privateKey: vapidPrivate });
        console.log(`Safari synthetic endpoint GET: ${JSON.stringify(evidence)}`);
      } finally { vapidPublic.fill(0); vapidPrivate.fill(0); }
    }
    if (process.env.CBTE_SAFARI_SYNTHETIC_PUSH_PROBE === '1') {
      const { sendHostedSafariFixturePush } = require('./safari-synthetic-push-probe.cjs');
      // The same client-message path used by the Push diagnostics must first
      // work for an independent, local-only service-worker control message.
      await exec('window.fixturePingWorker(); return true;', 'synthetic worker messaging control');
      const controlDeadline = Date.now() + 15000; let stages = { control: false, event: false, showResolved: false, showRejected: false, fetchFailed: false };
      while (!stages.control && Date.now() < controlDeadline) {
        stages = fixturePushStatus(await exec('return window.fixturePushStatus();', 'synthetic worker control status'));
        if (!stages.control) await delay(250);
      }
      if (!stages.control) throw new Error('FIXTURE_SAFARI_PUSH_CONTROL_NOT_CONFIRMED');
      console.log('Safari synthetic push: worker client-message control confirmed');
      const vapidPublic = Buffer.from(publicKey), vapidPrivate = key.getPrivateKey();
      fixtureSendStartedAt = Date.now();
      try { await sendHostedSafariFixturePush({ subscription: captured, publicKey: vapidPublic, privateKey: vapidPrivate, marker: pushMarker }); }
      finally { vapidPublic.fill(0); vapidPrivate.fill(0); }
      console.log('Safari synthetic push: provider accepted');
      const pushDeadline = Date.now() + 45000;
      while (Date.now() < pushDeadline) {
        stages = fixturePushStatus(await exec('return window.fixturePushStatus();', 'synthetic push status'));
        if (pushDelivered || stages.event && stages.showResolved || stages.showRejected) break;
        await delay(500);
      }
      console.log(`Safari synthetic push stages: ${JSON.stringify({ ...stages, loopbackReport: pushDelivered })}`);
      if (!pushDelivered && !(stages.event && stages.showResolved)) throw new Error('FIXTURE_SAFARI_PUSH_NOT_CONFIRMED');
      // The service worker's showNotification promise resolved; the test does
      // not assert that a human actually saw an OS notification banner.
      console.log('Safari synthetic push: showNotification resolved and fixture acknowledged');
    }
    await cleanup(true); clean = true;
    console.log('Safari subscription fixture: subscription and worker removed');
    await command(driverPort, 'DELETE', `/session/${session}`, undefined, 'session closure'); session = undefined;
  } finally {
    recordWebPushLogs(syntheticRunStartedAt, Date.now(), fixtureScope, fixtureSendStartedAt);
    // Collect while the synthetic session is still alive, even on timeout.
    await recordApnsDiagnostics('after');
    if (session && driver && driver.exitCode === null && driver.signalCode === null) {
      if (!clean) {
        try { await cleanup(); console.log('Safari subscription fixture: cleanup completed'); }
        catch { console.log('Safari subscription fixture: cleanup could not be confirmed'); }
      }
      try { await command(driverPort, 'DELETE', `/session/${session}`, undefined, 'session cleanup'); } catch { /* best effort */ }
    }
    if (driver && driver.exitCode === null && driver.signalCode === null) driver.kill('SIGTERM');
    if (listeningIPv6) { pageIPv6.closeAllConnections(); await close(pageIPv6); }
    if (listening) { page.closeAllConnections(); await close(page); }
    if (certBase) {
      const actual = await fs.realpath(certBase);
      assert.equal(path.dirname(actual), certTemp);
      assert.match(path.basename(actual), /^cbte-safari-subscribe-https-/);
      await fs.rm(actual, { recursive: true });
    }
    // Once a timed-out attempt has started, a late provider reply cannot be
    // ruled out; disposal of the hosted runner is part of the isolation boundary.
    if (attempted && !clean) console.log('Safari subscription fixture: runner disposal required for any late result');
  }
});
