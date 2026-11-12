'use strict';

// Only for disposable GitHub-hosted macOS runners. The fixture creates its own
// application server key, opens no external website, and sends no notification.
// A real subscription may contact Apple's push service. Its endpoint and keys
// stay in the page's memory and are never returned to the driver or logged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createECDH } = require('node:crypto');
const { Resolver, lookup } = require('node:dns/promises');
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
  // service label and one explicit boolean are accepted. Absence, unexpected
  // syntax, and duplicate entries do not establish whether the service runs.
  if (typeof output !== 'string' || output.length > 262144) return 'unknown';
  const matches = [...output.matchAll(/^[\t ]*"com\.apple\.apsd"[\t ]*=>[\t ]*(true|false)[\t ]*$/gm)];
  return matches.length === 1 ? matches[0][1] === 'true' : 'unknown';
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

function classifyWebPushLogs(output) {
  let entries;
  try { entries = JSON.parse(output); } catch { return { status: 'unknown' }; }
  if (!Array.isArray(entries) || entries.length > 1000) return { status: 'unknown' };
  const flags = Object.fromEntries(Object.keys(webPushMessages).map(name => [name, false]));
  for (const entry of entries) {
    const key = Object.keys(webPushMessages).find(name => webPushMessages[name] === entry?.eventMessage);
    if (!key) return { status: 'unknown' };
    flags[key] = true;
  }
  // False only means no matching recorded event was returned; it does not rule
  // out an issue, because log availability, versions and persistence differ.
  return { status: entries.length ? 'matched' : 'no_matches', ...flags };
}

function utcLogTime(milliseconds) {
  return new Date(milliseconds).toISOString().slice(0, 19).replace('T', ' ') + '+0000';
}

function recordWebPushLogs(startedAt, endedAt) {
  try {
    // Round inwards so the query never includes time outside the synthetic run.
    const start = Math.ceil(startedAt / 1000) * 1000;
    const end = Math.floor(endedAt / 1000) * 1000;
    if (end <= start || end - start > 15 * 60 * 1000) {
      console.log('Safari hosted WebPush log evidence: unknown');
      return;
    }
    const matches = Object.values(webPushMessages).map(message => `eventMessage == "${message}"`).join(' OR ');
    const predicate = `process == "webpushd" AND (${matches})`;
    const args = ['show', '--style', 'json', '--no-pager', '--info', '--start', utcLogTime(start),
      '--end', utcLogTime(end), '--predicate', predicate];
    const options = { timeout: 15000, encoding: 'utf8', maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'ignore'] };
    let result = spawnSync('/usr/bin/log', args, options);
    if (result.status !== 0) result = spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/log', ...args], options);
    const classified = result.status === 0 && typeof result.stdout === 'string'
      ? classifyWebPushLogs(result.stdout) : { status: 'unknown' };
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

function axProbe(mode) {
  const probe = spawnSync('/usr/bin/swift', [axProbePath, mode], {
    encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (probe.status !== 0) return 'unknown';
  const output = (probe.stdout || '').trim();
  if (mode === 'baseline' && output === 'baseline=clean') return 'clean';
  if (mode === 'baseline' && output === 'baseline=not_clean') return 'not_clean';
  if (mode === 'inspect' && output === 'diagnostic=notification_prompt_present') return 'notification_prompt_present';
  if (mode === 'allow' && output === 'diagnostic=allow_pressed') return 'allow_pressed';
  return 'unknown';
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

test('subscription result categories do not turn pending or refusal into success', () => {
  assert.equal(outcome('subscribed', 'granted'), 'subscribed');
  assert.equal(outcome('denied', 'default'), 'denied');
  assert.equal(outcome('pending', 'denied'), 'denied');
  assert.equal(outcome('pending', 'default'), 'permission_pending_timeout');
  assert.equal(outcome('pending', 'granted'), 'subscription_timeout_after_permission_granted');
  assert.equal(outcome('error', 'default'), 'subscription_error');
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
  assert.equal(parseApsdDisabledState('disabled services = {}'), 'unknown');
  assert.equal(parseApsdDisabledState('"com.apple.apsd" => true\n"com.apple.apsd" => false'), 'unknown');
  assert.equal(parseApsdDisabledState('"com.apple.apsd.other" => true'), 'unknown');
  assert.equal(parseApsdDisabledState('"com.apple.apsd" => yes'), 'unknown');
  assert.equal(parseApsdDisabledState('x'.repeat(262145)), 'unknown');
});

test('WebPush logs classify only known messages and reject malformed output', () => {
  assert.deepEqual(classifyWebPushLogs('[]'), { status: 'no_matches', service_unavailable: false,
    database_error: false, known_public_token: false, public_token_changed: false });
  const result = classifyWebPushLogs(JSON.stringify([{ eventMessage: webPushMessages.database_error,
    unrelatedSensitiveField: 'must not appear' }]));
  assert.equal(result.status, 'matched');
  assert.equal(result.database_error, true);
  assert.equal(JSON.stringify(result).includes('must not appear'), false);
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
  // Do not inspect a Safari process that predates this synthetic session.
  const baseline = axProbe('baseline');
  console.log(`Safari synthetic AX baseline: ${baseline}`);
  assert.equal(baseline, 'clean', 'Could not confirm that no Safari was running on the hosted runner');
  await recordApnsDiagnostics('before');
  const syntheticRunStartedAt = Date.now();
  let driver, driverPort, session, page, pageIPv6, certBase, certTemp, listening = false, listeningIPv6 = false, attempted = false, clean = false;
  const handler = (req, res) => {
    if (req.method === 'GET' && req.url === '/sw.js') {
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
      res.end("self.addEventListener('install', () => {});");
    } else if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><title>Push subscription fixture</title>
        <button id="subscribe" disabled>Subscribe</button><script>
        let registration, subscription, cancelled = false;
        let state = 'loading', trustedClick = false, activationAvailable = false, activationActive = false;
        window.fixtureStatus = () => ({state, permission: typeof Notification === 'undefined' ? 'unknown' : Notification.permission,
          trustedClick, activationAvailable, activationActive});
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
    await command(driverPort, 'POST', `/session/${session}/element/${elementId}/click`, {}, 'synthetic button click', 30000);
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
        const result = axProbe('allow');
        console.log(`Safari synthetic notification UI: ${result}`);
        axDiagnosticsReported = true;
        assert.equal(result, 'allow_pressed', 'Synthetic notification permission control was not uniquely verified');
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
    await cleanup(true); clean = true;
    console.log('Safari subscription fixture: subscription and worker removed');
    await command(driverPort, 'DELETE', `/session/${session}`, undefined, 'session closure'); session = undefined;
  } finally {
    recordWebPushLogs(syntheticRunStartedAt, Date.now());
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
