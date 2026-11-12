'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('hosted Edge integration refuses ordinary Windows environments before any setup',
    { skip: process.platform !== 'win32', timeout: 15000 }, () => {
        const script = path.join(__dirname, 'edge-hosted-package-integration.ps1');
        for (const env of [
            { GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'github-hosted' },
            { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' },
            { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: '' },
        ]) {
            const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], {
                env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 10000,
            });
            assert.equal(child.error, undefined); assert.notEqual(child.status, 0);
            assert.match(child.stderr, /SYNTHETIC_HOST_REQUIRED/);
        }
    });
