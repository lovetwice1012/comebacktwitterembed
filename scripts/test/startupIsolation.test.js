'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const consoleCapture = require('../../src/consoleCapture');

test('console capture excludes dashboard build output and its own delivery errors', () => {
    const buffer = { text: '' };

    assert.equal(consoleCapture.append(buffer, '[dashboard] compiling routes'), false);
    assert.equal(consoleCapture.append(buffer, '[consoleFlush] webhook failed'), false);
    assert.equal(consoleCapture.append(buffer, '[discord] shard reconnecting'), true);
    assert.equal(buffer.text, '[discord] shard reconnecting');
});

test('console capture has a hard memory bound', () => {
    const buffer = { text: '' };
    const max = consoleCapture._internal.MAX_BUFFER_CHARS;

    consoleCapture.append(buffer, 'x'.repeat(max + 1000));

    assert.equal(buffer.text.length, max);
    assert.equal(buffer.text.startsWith(consoleCapture._internal.TRUNCATION_MARKER), true);
});

test('dashboard stale build preparation finishes before capture and Discord login', () => {
    const root = path.join(__dirname, '..', '..');
    const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
    const dashboardScript = fs.readFileSync(
        path.join(root, 'dashboard', 'scripts', 'start-dashboard.js'),
        'utf8'
    );

    const preparePosition = indexSource.indexOf('await dashboardServer.prepare()');
    const capturePosition = indexSource.indexOf('installConsoleCapture()', preparePosition);
    const startPosition = indexSource.indexOf('dashboardServer.start()', preparePosition);
    const loginPosition = indexSource.indexOf('await client.login(config.token)');

    assert.ok(preparePosition >= 0);
    assert.ok(capturePosition > preparePosition);
    assert.ok(startPosition > capturePosition);
    assert.ok(loginPosition > startPosition);
    assert.match(dashboardScript, /mode === 'prepare'/);
    assert.match(dashboardScript, /ensureFreshProductionBuild\(dashboardDir, env\)/);
});

test('presence is part of identify and no periodic Gateway presence sender is active', () => {
    const root = path.join(__dirname, '..', '..');
    const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
    const readySource = fs.readFileSync(path.join(root, 'src', 'handlers', 'ready.js'), 'utf8');
    const presenceSource = fs.readFileSync(path.join(root, 'src', 'lifecycle', 'presence.js'), 'utf8');

    assert.match(indexSource, /presence:\s*\{/);
    assert.doesNotMatch(readySource, /presence\.start/);
    assert.doesNotMatch(presenceSource, /setInterval/);
});
