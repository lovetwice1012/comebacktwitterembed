'use strict';

// Only for disposable GitHub-hosted macOS runners. The fixture creates its own
// application server key, opens no external website, and sends no notification.
// A real subscription may contact Apple's push service. Its endpoint and keys
// stay in the page's memory and are never returned to the driver or logged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createECDH } = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');

const enabled = process.platform === 'darwin' && process.env.CBTE_SAFARI_PUSH_HOSTED === '1';

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

test('hosted Safari attempts a synthetic push subscription', { skip: !enabled, timeout: 360000 }, async () => {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions is required');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'A disposable GitHub-hosted runner is required');
  const key = createECDH('prime256v1');
  const publicKey = [...key.generateKeys()];
  let driver, driverPort, session, listening = false, attempted = false, clean = false;
  const page = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/sw.js') {
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
      res.end("self.addEventListener('install', () => {});");
    } else if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><title>Push subscription fixture</title>
        <button id="subscribe" disabled>Subscribe</button><script>
        let registration, subscription, cancelled = false;
        let state = 'loading';
        window.fixtureStatus = () => ({state, permission: typeof Notification === 'undefined' ? 'unknown' : Notification.permission});
        navigator.serviceWorker.register('/sw.js', {scope:'/'}).then(async r => {
          registration = r; await navigator.serviceWorker.ready;
          state = 'ready'; document.querySelector('#subscribe').disabled = false;
        }).catch(() => { state = 'error'; });
        document.querySelector('#subscribe').addEventListener('click', () => {
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
          const workerRemoved = !registration || await registration.unregister();
          return {removed, workerRemoved};
        };
        </script>`);
    } else res.writeHead(404).end();
  });
  const exec = async (script, stage, timeout = 15000) => command(driverPort, 'POST', `/session/${session}/execute/sync`, { script, args: [] }, stage, timeout);
  const cleanup = async () => {
    const result = await command(driverPort, 'POST', `/session/${session}/execute/async`, {
      script: 'const done=arguments[arguments.length-1]; window.fixtureCleanup().then(done,()=>done({removed:false,workerRemoved:false}));', args: [],
    }, 'fixture cleanup', 20000);
    assert.equal(result?.removed, true, 'Synthetic subscription could not be removed');
    assert.equal(result?.workerRemoved, true, 'Synthetic worker could not be unregistered');
  };
  try {
    const pagePort = await listen(page); listening = true;
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
    const created = await command(driverPort, 'POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } }, 'session creation', 90000);
    assert.match(created?.sessionId || '', /^[A-Za-z0-9-]{1,128}$/, 'Invalid WebDriver session ID');
    session = created.sessionId;
    assert.equal(created.capabilities?.browserName?.toLowerCase(), 'safari', 'Unexpected browser');
    await command(driverPort, 'POST', `/session/${session}/url`, { url: `http://127.0.0.1:${pagePort}/` }, 'fixture navigation', 30000);
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
    const subscriptionDeadline = Date.now() + 45000;
    do {
      status = await exec('return window.fixtureStatus();', 'subscription status');
      if (status?.state !== 'pending') break;
      await delay(500);
    } while (Date.now() < subscriptionDeadline);
    const result = outcome(status?.state, status?.permission);
    console.log(`Safari subscription fixture outcome: ${result}`);
    // A default permission state is evidence only of a pending decision, not that
    // a dialog appeared. Failure and timeout must never count as a subscription.
    assert.equal(result, 'subscribed', `Synthetic push subscription did not succeed: ${result}`);
    await cleanup(); clean = true;
    console.log('Safari subscription fixture: subscription and worker removed');
    await command(driverPort, 'DELETE', `/session/${session}`, undefined, 'session closure'); session = undefined;
  } finally {
    if (session && driver && driver.exitCode === null && driver.signalCode === null) {
      if (!clean) {
        try { await cleanup(); console.log('Safari subscription fixture: cleanup completed'); }
        catch { console.log('Safari subscription fixture: cleanup could not be confirmed'); }
      }
      try { await command(driverPort, 'DELETE', `/session/${session}`, undefined, 'session cleanup'); } catch { /* best effort */ }
    }
    if (driver && driver.exitCode === null && driver.signalCode === null) driver.kill('SIGTERM');
    if (listening) { page.closeAllConnections(); await close(page); }
    // Once a timed-out attempt has started, a late provider reply cannot be
    // ruled out; disposal of the hosted runner is part of the isolation boundary.
    if (attempted && !clean) console.log('Safari subscription fixture: runner disposal required for any late result');
  }
});
