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
    });
