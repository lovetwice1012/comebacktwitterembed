'use strict';

// This gate runs only on disposable GitHub-hosted macOS. It generates a local
// self-signed certificate, never modifies trust settings, and opens only the
// synthetic loopback page. It requests no notification permission or push data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const enabled = process.platform === 'darwin' && process.env.CBTE_SAFARI_HTTPS_HOSTED === '1';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
  });
}
function close(server) { return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
async function command(port, method, route, body, stage, timeout = 15000) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
    const data = await response.json();
    if (response.status !== 200) throw new Error('non-success response');
    return data.value;
  } catch (error) {
    // Suppress URLs, session identifiers and raw WebDriver responses.
    throw new Error(`Safari HTTPS ${stage}: ${error?.name === 'TimeoutError' ? 'timeout' : 'failed'}`);
  }
}

test('hosted Safari can use a self-signed local HTTPS fixture in an isolated automation session',
  { skip: !enabled, timeout: 240000 }, async () => {
    assert.equal(process.env.GITHUB_ACTIONS, 'true');
    assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
    const temp = await fs.realpath(os.tmpdir());
    const base = await fs.mkdtemp(path.join(temp, 'cbte-safari-https-fixture-'));
    assert.equal(path.dirname(await fs.realpath(base)), temp);
    let server, driver, driverPort, session, listening = false;
    try {
      await fs.chmod(base, 0o700);
      const generated = spawnSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=127.0.0.1', '-keyout', path.join(base, 'key.pem'), '-out', path.join(base, 'cert.pem')],
        { stdio: 'ignore', timeout: 30000 });
      assert.equal(generated.status, 0, 'Could not generate the isolated fixture certificate');
      const marker = randomBytes(16).toString('hex');
      server = https.createServer({ key: await fs.readFile(path.join(base, 'key.pem')), cert: await fs.readFile(path.join(base, 'cert.pem')) }, (req, res) => {
        if (req.method !== 'GET' || req.url !== '/') { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`<!doctype html><title>Local HTTPS fixture</title><main id="marker">${marker}</main>`);
      });
      const pagePort = await listen(server); listening = true;
      // A normal TLS client must reject the fixture, proving the test has not
      // silently relied on globally trusting its self-signed certificate.
      const rejected = await new Promise(resolve => {
        const request = https.get({ host: '127.0.0.1', port: pagePort, rejectUnauthorized: true, timeout: 5000 }, response => {
          response.resume(); resolve(false);
        });
        request.once('timeout', () => { request.destroy(); resolve(false); });
        request.once('error', error => resolve(error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || error.code === 'SELF_SIGNED_CERT_IN_CHAIN'));
      });
      assert.equal(rejected, true, 'The control client did not reject the fixture certificate');
      const reservation = net.createServer(); driverPort = await listen(reservation); await close(reservation);
      driver = spawn('/usr/bin/safaridriver', ['-p', String(driverPort)], { stdio: 'ignore' });
      let spawnError; driver.on('error', error => { spawnError = error; });
      let ready = false; const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !ready && !spawnError && driver.exitCode === null && driver.signalCode === null) {
        try { ready = (await command(driverPort, 'GET', '/status', undefined, 'readiness', 2000))?.ready === true; } catch { /* starting */ }
        if (!ready) await delay(250);
      }
      assert.ok(ready, 'WebDriver did not become ready');
      const created = await command(driverPort, 'POST', '/session', { capabilities: { alwaysMatch: {
        browserName: 'safari', acceptInsecureCerts: true,
      } } }, 'session creation', 90000);
      assert.match(created?.sessionId || '', /^[A-Za-z0-9-]{1,128}$/);
      session = created.sessionId;
      assert.equal(created.capabilities?.browserName?.toLowerCase(), 'safari');
      assert.equal(created.capabilities?.acceptInsecureCerts, true, 'Safari did not accept the session capability');
      await command(driverPort, 'POST', `/session/${session}/url`, { url: `https://127.0.0.1:${pagePort}/` }, 'fixture navigation', 30000);
      const actual = await command(driverPort, 'POST', `/session/${session}/execute/sync`, {
        script: 'return { title: document.title, marker: document.querySelector("#marker")?.textContent, secure: isSecureContext, protocol: location.protocol };', args: [],
      }, 'fixture inspection', 30000);
      assert.deepEqual(actual, { title: 'Local HTTPS fixture', marker, secure: true, protocol: 'https:' });
      console.log('Safari isolated HTTPS fixture: verified; no notification permission requested');
      await command(driverPort, 'DELETE', `/session/${session}`, undefined, 'session close'); session = undefined;
    } finally {
      if (session && driver && driver.exitCode === null && driver.signalCode === null)
        try { await command(driverPort, 'DELETE', `/session/${session}`, undefined, 'session cleanup'); } catch { /* disposable VM cleans up */ }
      if (driver && driver.exitCode === null && driver.signalCode === null) driver.kill('SIGTERM');
      if (listening) { server.closeAllConnections(); await close(server); }
      const actual = await fs.realpath(base);
      assert.equal(path.dirname(actual), temp);
      assert.match(path.basename(actual), /^cbte-safari-https-fixture-/);
      await fs.rm(actual, { recursive: true });
    }
  });
