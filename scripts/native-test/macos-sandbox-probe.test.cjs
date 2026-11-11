'use strict';
// Hosted synthetic probe only. No user profile, account or external endpoint.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const policy = '(version 1)(allow default)(deny process-fork)(deny network*)';
const env = { HOME: os.tmpdir(), TMPDIR: os.tmpdir(), PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' };
function python(source, args = []) {
    const child = spawnSync('/usr/bin/sandbox-exec', ['-p', policy, '/usr/bin/python3', '-c', source, ...args],
        { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(Boolean(child.error), false); assert.equal(child.status, 0);
    return child.stdout.trim();
}

test('macOS sandbox rejects a synthetic child process', { skip: process.platform !== 'darwin', timeout: 20000 }, () => {
    const result = python('import os\ntry:\n p=os.fork()\n if p==0: os._exit(0)\n os.waitpid(p,0)\n print("allowed")\nexcept OSError as e:\n print("denied:"+str(e.errno))\n');
    assert.match(result, /^denied:(1|13)$/);
});

test('macOS sandbox rejects a synthetic loopback connection', { skip: process.platform !== 'darwin', timeout: 20000 }, async t => {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const port = server.address().port;
    const result = python('import socket,sys\ntry:\n s=socket.socket()\n s.settimeout(2)\n s.connect(("127.0.0.1",int(sys.argv[1])))\n s.close()\n print("allowed")\nexcept OSError as e:\n print("denied:"+str(e.errno))\n', [String(port)]);
    assert.match(result, /^denied:(1|13)$/);
});
