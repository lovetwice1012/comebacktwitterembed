'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('hosted mode flags select only the intended synthetic batch', { skip: process.platform !== 'win32' }, () => {
    const helper = path.join(__dirname, 'edge-hosted-probe-mode.ps1').replace(/'/g, "''");
    const invoke = mode => {
        const source = `$ErrorActionPreference='Stop'; . '${helper}'; ConvertTo-Json -InputObject @(Get-XEdgeHostedProbeFlags -Mode $env:CBTE_TEST_MODE) -Compress`;
        return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
            env: { ...process.env, CBTE_TEST_MODE: mode }, encoding: 'utf8', windowsHide: true, timeout: 10000,
        });
    };
    const shared = ['EDGE_PROBE_TAKEOVER=1', 'EDGE_PROBE_BLOCK_WNS=1', 'EDGE_PROBE_REIMPORT=1',
        'EDGE_PROBE_OFFLINE_MESSAGE=1', 'EDGE_PROBE_OFFLINE_BATCH=1'];
    for (const [mode, expected] of [
        ['normal', []],
        ['online-batch', [...shared, 'EDGE_PROBE_BATCH_ONLINE=1']],
        ['offline-batch', [...shared, 'EDGE_PROBE_OFFLINE_SETTLE=1']],
        ['offline-status', [...shared, 'EDGE_PROBE_OFFLINE_SETTLE=1', 'EDGE_PROBE_REQUEST_STATUS=1']],
        ['offline-cache', [...shared, 'EDGE_PROBE_OFFLINE_SETTLE=1', 'EDGE_PROBE_REQUEST_STATUS=1', 'EDGE_PROBE_CACHE_POLICY=cache']],
        ['offline-no-cache', [...shared, 'EDGE_PROBE_OFFLINE_SETTLE=1', 'EDGE_PROBE_REQUEST_STATUS=1', 'EDGE_PROBE_CACHE_POLICY=no-cache']],
        ['ONLINE-BATCH', [...shared, 'EDGE_PROBE_BATCH_ONLINE=1']],
    ]) {
        const result = invoke(mode);
        assert.equal(result.error, undefined); assert.equal(result.status, 0);
        assert.deepEqual(JSON.parse(result.stdout), expected);
    }
    assert.notEqual(invoke('unknown').status, 0);
});

test('hosted batch success checks apply equally to uppercase modes', { skip: process.platform !== 'win32' }, () => {
    const helper = path.join(__dirname, 'edge-hosted-probe-mode.ps1').replace(/'/g, "''");
    const source = `$ErrorActionPreference='Stop'; . '${helper}'; $fixture=$env:CBTE_TEST_RESULT | ConvertFrom-Json; Assert-XEdgeHostedProbeResult -Mode $env:CBTE_TEST_MODE -Result $fixture`;
    const invoke = (mode, result) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
        env: { ...process.env, CBTE_TEST_MODE: mode, CBTE_TEST_RESULT: JSON.stringify(result) }, encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    const good = { syntheticProfile: true, realWnsWorkerTested: true, databaseRecovery: true, packagedExport: true,
        packagedSnapshotCleaned: true, otherSiteConsentRequired: true, explicitConnectVersion: '2',
        takeoverResult: { receivedAfterForcedWorkerExit: true, batchPersistedOnce: true, receivedSentWhileOffline: true } };
    for (const mode of ['normal', 'NORMAL', 'online-batch', 'ONLINE-BATCH', 'offline-batch', 'OFFLINE-BATCH', 'offline-status', 'OFFLINE-STATUS', 'offline-cache', 'offline-no-cache']) {
        assert.equal(invoke(mode, good).status, 0);
    }
    const missingOffline = { ...good, takeoverResult: { ...good.takeoverResult, receivedSentWhileOffline: false } };
    for (const mode of ['offline-batch', 'OFFLINE-BATCH', 'offline-status', 'OFFLINE-STATUS', 'offline-cache', 'offline-no-cache']) assert.notEqual(invoke(mode, missingOffline).status, 0);
    const missingBatch = { ...good, takeoverResult: { ...good.takeoverResult, batchPersistedOnce: false } };
    for (const mode of ['online-batch', 'ONLINE-BATCH', 'offline-batch', 'OFFLINE-BATCH', 'offline-status', 'OFFLINE-STATUS', 'offline-cache', 'offline-no-cache']) assert.notEqual(invoke(mode, missingBatch).status, 0);
    assert.notEqual(invoke('normal', { ...good, explicitConnectVersion: '1' }).status, 0);
});

test('hosted response diagnostics accept only fixed sanitized status categories', { skip: process.platform !== 'win32' }, () => {
    const helper = path.join(__dirname, 'edge-hosted-probe-mode.ps1').replace(/'/g, "''");
    const source = `$ErrorActionPreference='Stop'; . '${helper}'; if ($null -eq (Get-XEdgeHostedSendStatus -Value $env:CBTE_TEST_STATUS)) { exit 1 }`;
    const invoke = value => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
        env: { ...process.env, CBTE_TEST_STATUS: value }, encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    assert.equal(invoke('H201-DDISCONNECTED-WRECEIVED;H201-DABSENT-WABSENT').status, 0);
    for (const value of ['secret-endpoint', 'H201-DSECRET-WRECEIVED', 'H201-DDISCONNECTED-WRECEIVED\nsecret', Array(4).fill('H201-DABSENT-WABSENT').join(';')])
        assert.notEqual(invoke(value).status, 0);
});
