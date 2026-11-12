'use strict';

// This smoke test intentionally never opens a user profile, requests notification
// permission, subscribes to push, or accesses any remote service. It exercises
// only a WebDriver-created Safari session and a synthetic loopback page/worker.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');

const enabled = process.platform === 'darwin' && process.env.CBTE_SAFARI_HOSTED === '1';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function webdriver(port, path, method = 'GET', payload, options = {}) {
  const { stage = 'request', timeoutMs = 5000 } = options;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json();
    return { status: response.status, value: data.value };
  } catch (error) {
    // Do not echo request URLs, session IDs, or raw driver responses into CI logs.
    const category = error?.name === 'TimeoutError' ? 'timeout' : 'transport or invalid response';
    throw new Error(`Safari WebDriver ${stage}: ${category} after at most ${timeoutMs} ms`);
  }
}

test('WebDriver timeout identifies the operation without exposing its URL', async () => {
  const server = http.createServer(() => {});
  const port = await listen(server);
  try {
    await assert.rejects(webdriver(port, '/synthetic-secret', 'GET', undefined, {
      stage: 'synthetic operation', timeoutMs: 100,
    }), (error) => error.message === 'Safari WebDriver synthetic operation: timeout after at most 100 ms');
  } finally {
    server.closeAllConnections();
    await close(server);
  }
});

test('hosted Safari WebDriver visits a loopback fixture', { skip: !enabled, timeout: 360000 }, async () => {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions is required');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'A disposable GitHub-hosted runner is required');

  const marker = randomBytes(16).toString('hex');
  const page = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/sw.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end("self.addEventListener('install', () => {});");
      return;
    }
    if (req.method !== 'GET' || req.url !== '/') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><title>CBTE local fixture</title><main id="marker">${marker}</main>`);
  });
  let driver;
  let driverPort;
  let sessionId;
  let pageListening = false;
  let workerAttempted = false;
  let workerCleared = false;
  async function unregisterWorker() {
    const result = await webdriver(driverPort, `/session/${sessionId}/execute/async`, 'POST', {
      script: `const done = arguments[arguments.length - 1];
        navigator.serviceWorker.getRegistration('/')
          .then(async registration => {
            if (registration && !(await registration.unregister())) return { removed: false };
            return { removed: !(await navigator.serviceWorker.getRegistration('/')) };
          })
          .then(done, () => done({ removed: false }));`,
      args: [],
    }, { stage: 'worker cleanup', timeoutMs: 15000 });
    assert.equal(result.status, 200, 'Could not inspect worker cleanup');
    assert.equal(result.value?.removed, true, 'Could not unregister the synthetic worker');
  }
  try {
    const pagePort = await listen(page);
    pageListening = true;
    // Reserve an ephemeral port only long enough to select it for safaridriver.
    const reservation = net.createServer();
    driverPort = await listen(reservation);
    await close(reservation);
    driver = spawn('/usr/bin/safaridriver', ['-p', String(driverPort)], { stdio: 'ignore' });
    let spawnError;
    driver.on('error', (error) => { spawnError = error; });

    let ready = false;
    console.log('Safari WebDriver: waiting for driver readiness');
    const readyDeadline = Date.now() + 20000;
    while (Date.now() < readyDeadline && !ready) {
      if (spawnError || driver.exitCode !== null || driver.signalCode !== null) break;
      try {
        const status = await webdriver(driverPort, '/status', 'GET', undefined, { stage: 'readiness', timeoutMs: 2000 });
        ready = status.status === 200 && status.value?.ready === true;
      } catch {
        // The driver may not yet be listening.
      }
      if (!ready) await delay(250);
    }
    assert.ok(ready, 'Safari WebDriver did not become ready');
    console.log('Safari WebDriver: driver ready; creating session');

    const created = await webdriver(driverPort, '/session', 'POST', {
      capabilities: { alwaysMatch: { browserName: 'safari' } },
    }, { stage: 'session creation', timeoutMs: 90000 });
    assert.equal(created.status, 200, 'Could not create Safari WebDriver session');
    assert.match(created.value?.sessionId || '', /^[A-Za-z0-9-]{1,128}$/, 'Invalid WebDriver session ID');
    sessionId = created.value.sessionId;
    assert.equal(created.value.capabilities?.browserName?.toLowerCase(), 'safari', 'Unexpected browser');
    console.log('Safari WebDriver: session created; navigating to fixture');

    const url = `http://127.0.0.1:${pagePort}/`;
    const navigated = await webdriver(driverPort, `/session/${sessionId}/url`, 'POST', { url }, {
      stage: 'fixture navigation', timeoutMs: 30000,
    });
    assert.equal(navigated.status, 200, 'Could not open the synthetic page');
    console.log('Safari WebDriver: fixture opened; reading document');
    const result = await webdriver(driverPort, `/session/${sessionId}/execute/sync`, 'POST', {
      script: 'return { title: document.title, origin: location.origin, marker: document.querySelector("#marker").textContent };',
      args: [],
    }, { stage: 'fixture inspection', timeoutMs: 30000 });
    assert.equal(result.status, 200, 'Could not read the synthetic page');
    assert.deepEqual(result.value, { title: 'CBTE local fixture', origin: `http://127.0.0.1:${pagePort}`, marker });

    console.log('Safari WebDriver: fixture verified; checking API availability');
    const capabilities = await webdriver(driverPort, `/session/${sessionId}/execute/sync`, 'POST', {
      script: `return { secureContext: isSecureContext, serviceWorker: 'serviceWorker' in navigator,
        pushManager: 'PushManager' in window, notification: 'Notification' in window };`,
      args: [],
    }, { stage: 'API availability', timeoutMs: 30000 });
    assert.equal(capabilities.status, 200, 'Could not check web API availability');
    console.log(`Safari fixture API availability: ${JSON.stringify(capabilities.value)}`);
    assert.equal(capabilities.value?.secureContext, true, 'Fixture is not a secure context');
    assert.equal(capabilities.value?.serviceWorker, true, 'Service Worker API is unavailable');

    console.log('Safari WebDriver: registering synthetic worker');
    workerAttempted = true;
    const registration = await webdriver(driverPort, `/session/${sessionId}/execute/async`, 'POST', {
      script: `const done = arguments[arguments.length - 1];
        navigator.serviceWorker.register('/sw.js', { scope: '/' })
          .then(registration => done({ registered: true, scopeMatches: registration.scope === location.origin + '/',
            state: registration.active ? 'active' : registration.waiting ? 'waiting' : registration.installing ? 'installing' : 'unknown' }),
          () => done({ registered: false }));`,
      args: [],
    }, { stage: 'worker registration', timeoutMs: 30000 });
    assert.equal(registration.status, 200, 'Could not inspect worker registration');
    console.log(`Safari fixture worker registration: ${JSON.stringify(registration.value)}`);
    assert.equal(registration.value?.registered, true, 'Synthetic worker registration failed');
    assert.equal(registration.value?.scopeMatches, true, 'Synthetic worker scope does not match fixture');
    assert.ok(['active', 'waiting', 'installing'].includes(registration.value?.state), 'Synthetic worker has no registration state');

    console.log('Safari WebDriver: unregistering synthetic worker');
    await unregisterWorker();
    workerCleared = true;
    assert.equal(capabilities.value?.pushManager, true, 'PushManager API is unavailable');
    assert.equal(capabilities.value?.notification, true, 'Notification API is unavailable');
    console.log('Safari WebDriver: worker unregistered; closing session');
    const deleted = await webdriver(driverPort, `/session/${sessionId}`, 'DELETE', undefined, {
      stage: 'session closure', timeoutMs: 15000,
    });
    sessionId = undefined;
    assert.equal(deleted.status, 200, 'Could not close Safari WebDriver session');
    console.log('Safari WebDriver: session closed');
  } finally {
    if (sessionId && driver && driver.exitCode === null && driver.signalCode === null) {
      if (workerAttempted && !workerCleared) {
        // This can only address the synthetic origin in this automation window.
        try { await unregisterWorker(); } catch { /* preserve the original test failure */ }
      }
      // Limit cleanup to the automation session created by this test.
      try { await webdriver(driverPort, `/session/${sessionId}`, 'DELETE'); } catch { /* best effort */ }
    }
    if (driver && driver.exitCode === null && driver.signalCode === null) driver.kill('SIGTERM');
    if (pageListening) {
      page.closeAllConnections();
      await close(page);
    }
  }
});
