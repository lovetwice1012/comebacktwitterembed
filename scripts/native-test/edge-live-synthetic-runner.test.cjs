'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const runner = path.join(__dirname, 'edge-live-synthetic-runner.ps1');
function expectRefusal(args, reason = 'SYNTHETIC_TEST_ONLY') {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-File', runner, '-Node', process.execPath, ...args,
  ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes(reason));
}

test('requires explicit test-only consent', { skip: process.platform !== 'win32' }, () => {
  expectRefusal([]);
});

test('reimport requires the takeover scenario', { skip: process.platform !== 'win32' }, () => {
  expectRefusal(['-TestOnly', '-Reimport']);
});

test('refuses to run without the disposable database', { skip: process.platform !== 'win32' }, (t) => {
  const inspect = spawnSync('docker', ['inspect', 'cbte-edge-live-synthetic-20261111'], {
    stdio: 'ignore', windowsHide: true, timeout: 10000,
  });
  if (inspect.status === 0) {
    t.skip('the disposable database container exists');
    return;
  }
  expectRefusal(['-TestOnly'], 'SYNTHETIC_DATABASE_REQUIRED');
});
