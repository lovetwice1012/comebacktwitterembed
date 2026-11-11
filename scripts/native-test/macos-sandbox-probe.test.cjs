'use strict';
// Hosted synthetic probe only. No user profile, account or external endpoint.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const policy = '(version 1)(allow default)(deny process-fork)(deny network*)';
const env = { HOME: os.tmpdir(), TMPDIR: os.tmpdir(), PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' };
function node(source, args = []) {
    const child = spawnSync('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, '-e', source, '--', ...args],
        { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(Boolean(child.error), false); assert.equal(child.status, 0);
    return child.stdout.trim();
}

test('macOS sandbox rejects a synthetic child process', { skip: process.platform !== 'darwin', timeout: 20000 }, () => {
    const result = node('const r=require("node:child_process").spawnSync("/bin/true");console.log(r.error?"denied:"+r.error.code:r.status===0?"allowed":"other");');
    assert.match(result, /^denied:(EPERM|EACCES)$/);
});

test('macOS sandbox rejects a synthetic loopback connection', { skip: process.platform !== 'darwin', timeout: 20000 }, async t => {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const port = server.address().port;
    const result = node('const s=require("node:net").connect(Number(process.argv[1]),"127.0.0.1");const timer=setTimeout(()=>{console.log("timeout");s.destroy()},2000);s.on("connect",()=>{clearTimeout(timer);console.log("allowed");s.destroy()});s.on("error",e=>{clearTimeout(timer);console.log("denied:"+e.code)});', [String(port)]);
    assert.match(result, /^denied:(EPERM|EACCES)$/);
});
