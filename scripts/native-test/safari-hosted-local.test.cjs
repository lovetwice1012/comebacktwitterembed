'use strict';

// This smoke test intentionally never opens a user profile, requests notification
// permission, subscribes to push, or accesses any remote service. It exercises
// only a WebDriver-created Safari session and a synthetic loopback page.
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

async function webdriver(port, path, method = 'GET', payload) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: payload === undefined ? {} : { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  return { status: response.status, value: data.value };
}

test('hosted Safari WebDriver visits a loopback fixture', { skip: !enabled, timeout: 90000 }, async () => {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions is required');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'A disposable GitHub-hosted runner is required');

  const marker = randomBytes(16).toString('hex');
  const page = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><title>CBTE local fixture</title><main id="marker">${marker}</main>`);
  });
  let driver;
  let sessionId;
  let pageListening = false;
  try {
    const pagePort = await listen(page);
    pageListening = true;
    // Reserve an ephemeral port only long enough to select it for safaridriver.
    const reservation = net.createServer();
    const driverPort = await listen(reservation);
    await close(reservation);
    driver = spawn('/usr/bin/safaridriver', ['-p', String(driverPort)], { stdio: 'ignore' });
    let spawnError;
    driver.on('error', (error) => { spawnError = error; });

    let ready = false;
    for (let attempt = 0; attempt < 80 && !ready; attempt++) {
      if (spawnError || driver.exitCode !== null || driver.signalCode !== null) break;
      try {
        const status = await webdriver(driverPort, '/status');
        ready = status.status === 200 && status.value?.ready === true;
      } catch {
        // The driver may not yet be listening.
      }
      if (!ready) await delay(250);
    }
    assert.ok(ready, 'Safari WebDriver did not become ready');

    const created = await webdriver(driverPort, '/session', 'POST', {
      capabilities: { alwaysMatch: { browserName: 'safari' } },
    });
    assert.equal(created.status, 200, 'Could not create Safari WebDriver session');
    assert.match(created.value?.sessionId || '', /^[A-Za-z0-9-]{1,128}$/, 'Invalid WebDriver session ID');
    sessionId = created.value.sessionId;
    assert.equal(created.value.capabilities?.browserName?.toLowerCase(), 'safari', 'Unexpected browser');

    const url = `http://127.0.0.1:${pagePort}/`;
    const navigated = await webdriver(driverPort, `/session/${sessionId}/url`, 'POST', { url });
    assert.equal(navigated.status, 200, 'Could not open the synthetic page');
    const result = await webdriver(driverPort, `/session/${sessionId}/execute/sync`, 'POST', {
      script: 'return { title: document.title, origin: location.origin, marker: document.querySelector("#marker").textContent };',
      args: [],
    });
    assert.equal(result.status, 200, 'Could not read the synthetic page');
    assert.deepEqual(result.value, { title: 'CBTE local fixture', origin: `http://127.0.0.1:${pagePort}`, marker });

    const deleted = await webdriver(driverPort, `/session/${sessionId}`, 'DELETE');
    sessionId = undefined;
    assert.equal(deleted.status, 200, 'Could not close Safari WebDriver session');
  } finally {
    if (sessionId && driver && driver.exitCode === null && driver.signalCode === null) {
      // Limit cleanup to the automation session created by this test.
      try { await webdriver(Number(driver.spawnargs.at(-1)), `/session/${sessionId}`, 'DELETE'); } catch { /* best effort */ }
    }
    if (driver && driver.exitCode === null && driver.signalCode === null) driver.kill('SIGTERM');
    if (pageListening) {
      page.closeAllConnections();
      await close(page);
    }
  }
});
