'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');

test('real signed Edge synthetic calibration reveals a parseable connect-agent shape',
    { skip: process.platform !== 'win32' || process.env.CBTE_RUN_EDGE_AGENT_PROBE !== '1', timeout: 90000 }, async t => {
        const temp = await fs.realpath(os.tmpdir()), base = path.join(temp, `cbte-edge-agent-probe-${randomBytes(16).toString('hex')}`);
        await fs.mkdir(base);
        t.after(async () => {
            const real = await fs.realpath(base); assert.equal(path.dirname(real).toLowerCase(), temp.toLowerCase());
            assert.match(path.basename(real), /^cbte-edge-agent-probe-[0-9a-f]{32}$/); await fs.rm(real, { recursive: true });
        });
        const runner = path.join(__dirname, 'edge-real-agent-probe.ps1');
        const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const child = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner,
            '-Base', base, '-Node', process.execPath], { encoding: 'utf8', windowsHide: true, timeout: 85000 });
        if (child.error) throw child.error;
        assert.equal(child.status, 0, child.stderr || 'synthetic probe failed');
        const result = JSON.parse(child.stdout);
        assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.agentFormatRecognized, true);
        assert(['1', '2'].includes(result.connectVersion));
        if (process.env.CBTE_RUN_EDGE_CONNECT_PROBE === '1') {
            assert(Array.isArray(result.connections)); assert.deepEqual(result.connections.map(item => item.version), ['1', '2']);
            for (const item of result.connections) assert.match(item.status, /^(?:accepted|X_EDGE_WNS_[A-Z_]+|PROBE_EXCHANGE_FAILED)$/);
            t.diagnostic(`synthetic CNT results: ${JSON.stringify(result.connections)}`);
        }
        if (['1', '2'].includes(process.env.CBTE_RUN_EDGE_AUTH_VERSION)) {
            assert.equal(result.authentication?.version, process.env.CBTE_RUN_EDGE_AUTH_VERSION);
            const expected = process.env.CBTE_RUN_EDGE_RECONNECT_PROBE === '1' ? 'reconnected' : 'bound';
            assert.equal(result.authentication?.status, expected, JSON.stringify(result.authentication));
            t.diagnostic(`synthetic WNS ${expected} for version ${result.authentication.version}`);
        }
        if (process.env.CBTE_RUN_EDGE_SESSION_PROBE === '1') {
            assert.equal(result.receiverSession?.status, 'resumed', JSON.stringify(result.receiverSession));
            t.diagnostic('synthetic receiver session resumed with the returned token');
        }
    });
